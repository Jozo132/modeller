// js/main.js — Application entry point
import { state } from './state.js';
import { Viewport } from './viewport.js';
import { WasmRenderer } from './wasm-renderer.js';
import { PartManager } from './part-manager.js';
import { FeaturePanel } from './ui/featurePanel.js';
import { ParametersPanel } from './ui/parametersPanel.js';
import { getSnappedPosition } from './snap.js';
import { undo, redo, takeSnapshot, setPartManager } from './history.js';
import { downloadDXF } from './dxf/export.js';
import { openDXFFile } from './dxf/import.js';
import { debug, info, warn, error } from './logger.js';
import { loadProject, debouncedSave, clearSavedProject, setViewport } from './persist.js';
import { showConfirm, showPrompt, showDimensionInput } from './ui/popup.js';
import { showContextMenu, closeContextMenu, isContextMenuOpen } from './ui/contextMenu.js';
import {
  Coincident, Horizontal, Vertical,
  Parallel, Perpendicular, EqualLength,
  Fixed, Distance, Tangent, Angle,
  resolveValue, setVariable, getVariable, getVariableRaw, removeVariable, getAllVariables,
} from './cad/Constraint.js';
import { union } from './cad/Operations.js';
import { motionAnalysis } from './motion.js';
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
    this._renderer3d = null;
    this._workspaceMode = null; // 'sketch' | 'part' | null (quick-start)
    this._sketchingOnPlane = false; // true when in sketch-on-plane mode inside Part workspace
    this._activeSketchPlane = null; // plane reference for current sketch
    this._selectedPlane = null; // currently selected plane in Part mode ('XY', 'XZ', 'YZ', or null)
    this._selectedFace = null; // currently selected 3D face in Part mode
    
    // Initialize unified 3D renderer
    const view3dContainer = document.getElementById('view-3d');
    this._renderer3d = new WasmRenderer(view3dContainer);
    this._renderer3d.setMode('2d'); // Start in 2D sketching mode
    this._renderer3d.setVisible(true);
    
    this.canvas = document.getElementById('cad-canvas');
    this.viewport = new Viewport(this.canvas);

    // Render state used by tools to communicate hover/preview/snap/cursor info
    this.renderer = {
      hoverEntity: null,
      previewEntities: [],
      snapPoint: null,
      cursorWorld: null,
    };
    
    this._pointerFramePending = false;
    this._lastPointer = null;
    this._moveEventCount = 0;
    this._renderScheduled = false;
    this._renderRequested = false;
    this._sceneVersion = 1;

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

    // 3D Part management
    this._3dMode = false;
    this._partManager = new PartManager();
    setPartManager(this._partManager);
    this._featurePanel = null;
    this._parametersPanel = null;
    this._lastSketchFeatureId = null;

    // Bind events
    this._bind3DCanvasEvents(); // 3D-only interactions
    this._bindToolbarEvents();
    this._bindKeyboardEvents();
    this._bindResizeEvent();
    this._bindStateEvents();
    this._bindLeftPanelEvents();
    this._bindMotionEvents();
    this._bind3DEvents();
    this._bindQuickStartEvents();
    this._bindPartToolEvents();
    this._bindPlaneSelectionEvents();
    this._bindExitSketchButton();

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

    // Show quick-start page on startup
    this._showQuickStart();

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
        if (this._sketchingOnPlane) {
          // Sketching on a plane in 3D: render both mesh and sketch entities
          this._renderer3d.render2DScene(state.scene, {
            sceneVersion: this._sceneVersion,
            hoverEntity: this.renderer.hoverEntity,
            previewEntities: this.renderer.previewEntities,
            snapPoint: this.renderer.snapPoint,
            cursorWorld: this.renderer.cursorWorld,
            isLayerVisible: (layer) => state.isLayerVisible(layer),
            getLayerColor: (layer) => state.getLayerColor(layer),
            allDimensionsVisible: state.allDimensionsVisible,
            constraintIconsVisible: state.constraintIconsVisible,
          });
        } else if (!this._3dMode) {
          this._renderer3d.sync2DView(this.viewport);
          this._renderer3d.render2DScene(state.scene, {
            sceneVersion: this._sceneVersion,
            hoverEntity: this.renderer.hoverEntity,
            previewEntities: this.renderer.previewEntities,
            snapPoint: this.renderer.snapPoint,
            cursorWorld: this.renderer.cursorWorld,
            isLayerVisible: (layer) => state.isLayerVisible(layer),
            getLayerColor: (layer) => state.getLayerColor(layer),
            allDimensionsVisible: state.allDimensionsVisible,
            constraintIconsVisible: state.constraintIconsVisible,
          });
        } else {
          // Pure 3D mode (no sketching): clear the overlay canvas so
          // stale 2D overlays (axes, dimensions, constraint icons) don't
          // persist from a previous sketch session.
          this._renderer3d.clearOverlay();
        }
      } catch (err) {
        error('Render loop failed', err);
      }

      if (this._renderRequested) {
        this._scheduleRender();
      }
    };

    requestAnimationFrame(runRender);
  }

  _syncViewportSize() {
    // Read the actual container dimensions to ensure viewport, WebGL canvas,
    // and overlay canvas all agree on the exact same pixel dimensions.
    const container = this._renderer3d?.container || document.getElementById('view-3d');
    if (!container) return;

    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);

    if (width !== this.viewport.width || height !== this.viewport.height) {
      this.viewport.resize(width, height);
      if (this._renderer3d) this._renderer3d.onWindowResize();
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

      let world, snap;
      if (this.activeTool.freehand) {
        world = this.viewport.screenToWorld(sx, sy);
        snap = null;
      } else {
        const basePoint = this.activeTool._startX !== undefined && this.activeTool.step > 0
          ? { x: this.activeTool._startX, y: this.activeTool._startY }
          : null;
        const result = getSnappedPosition(
          sx, sy, this.viewport, basePoint,
          { ignoreGridSnap: !!ctrlKey }
        );
        world = result.world;
        snap = result.snap;
      }

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

  /**
   * Pointer processing for sketch-on-plane in 3D mode.
   * Uses rayToPlane instead of 2D viewport screenToWorld.
   */
  _scheduleSketchPointerProcessing() {
    if (this._pointerFramePending || !this._lastPointer) return;
    this._pointerFramePending = true;
    requestAnimationFrame(() => {
      this._pointerFramePending = false;
      if (!this._lastPointer) return;
      const { sx, sy, ctrlKey } = this._lastPointer;

      const world = this._screenToSketchWorld(sx, sy);
      if (!world) return;

      this.renderer.cursorWorld = world;
      this.renderer.snapPoint = null; // TODO: snap support in 3D sketch mode

      document.getElementById('status-coords').textContent =
        `X: ${world.x.toFixed(2)}  Y: ${world.y.toFixed(2)}`;

      this.activeTool.onMouseMove(world.x, world.y, sx, sy);
      this._updateLeftPanelHighlights();
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
    // Block tool changes during motion playback (except select)
    if (motionAnalysis.isRunning && name !== 'select') return;
    // Block drawing/editing tools in 3D view mode (only select allowed)
    // but allow them during sketch-on-plane mode in Part workspace
    if (this._3dMode && !this._sketchingOnPlane && name !== 'select') return;
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

  _toggleConstructionMode() {
    state.constructionMode = !state.constructionMode;
    const btn = document.getElementById('btn-construction');
    btn.classList.toggle('active', state.constructionMode);
    // Tint all Draw tool buttons when construction mode is active
    const drawBtns = document.querySelectorAll('#btn-line, #btn-rect, #btn-circle, #btn-arc, #btn-polyline');
    for (const b of drawBtns) {
      b.classList.toggle('construction-mode', state.constructionMode);
    }
  }

  // --- Context Menu ---
  _deleteSelection() {
    for (const e of [...state.selectedEntities]) {
      state.removeEntity(e);
    }
    state.clearSelection();
    this._scheduleRender();
  }

  _showContextMenu(x, y, entity) {
    const items = [];

    if (entity) {
      // Select the entity if not already selected
      if (!entity.selected) {
        state.selectedEntities.forEach(e => e.selected = false);
        state.selectedEntities = [entity];
        entity.selected = true;
        state.emit('change');
        this._scheduleRender();
      }

      const isShape = entity.type === 'segment' || entity.type === 'circle' || entity.type === 'arc';

      if (isShape) {
        // Toggle construction
        items.push({
          type: 'item',
          label: entity.construction ? 'Make Normal' : 'Make Construction',
          icon: entity.construction ? '━' : '┄',
          shortcut: 'Q',
          action: () => {
            takeSnapshot();
            entity.construction = !entity.construction;
            state.emit('change');
            this._scheduleRender();
          },
        });

        // Construction type submenu (only for segments, and only if already construction or about to become one)
        if (entity.type === 'segment' && entity.construction) {
          const currentType = entity.constructionType || 'finite';
          const typeOptions = [
            { key: 'finite', label: 'Finite', icon: currentType === 'finite' ? '✓' : '' },
            { key: 'infinite-start', label: 'Infinite Start', icon: currentType === 'infinite-start' ? '✓' : '' },
            { key: 'infinite-end', label: 'Infinite End', icon: currentType === 'infinite-end' ? '✓' : '' },
            { key: 'infinite-both', label: 'Infinite Both', icon: currentType === 'infinite-both' ? '✓' : '' },
          ];
          items.push({
            type: 'submenu',
            label: 'Construction Type',
            icon: '⇔',
            items: typeOptions.map(opt => ({
              type: 'item',
              label: opt.label,
              icon: opt.icon,
              action: () => {
                takeSnapshot();
                entity.constructionType = opt.key;
                state.emit('change');
                this._scheduleRender();
              },
            })),
          });
        }

        // Dash style submenu (for all construction shapes)
        if (entity.construction) {
          const currentDash = entity.constructionDash || 'dashed';
          const dashArrays = {
            'dashed':   '6,4',
            'dash-dot': '6,3,1,3',
            'dotted':   '1.5,3',
          };
          const dashLabels = {
            'dashed':   'Dashed',
            'dash-dot': 'Dash-Dot',
            'dotted':   'Dotted',
          };
          const dashOptions = Object.keys(dashArrays).map(key => ({
            key,
            label: dashLabels[key],
            icon: currentDash === key ? '✓' : '',
            svg: `<svg width="40" height="2" viewBox="0 0 40 2" style="display:block"><line x1="0" y1="1" x2="40" y2="1" stroke="#ccc" stroke-width="1.5" stroke-dasharray="${dashArrays[key]}"/></svg>`,
          }));
          items.push({
            type: 'submenu',
            label: 'Dash Style',
            icon: '┄',
            items: dashOptions.map(opt => ({
              type: 'item',
              label: opt.label,
              icon: opt.icon,
              labelHtml: `<span style="display:flex;align-items:center;gap:10px"><span>${opt.label}</span>${opt.svg}</span>`,
              action: () => {
                takeSnapshot();
                entity.constructionDash = opt.key;
                state.emit('change');
                this._scheduleRender();
              },
            })),
          });
        }

        items.push(this._thicknessSubmenu([entity]));
        items.push({ type: 'separator' });
      }

      // Dimension-specific options
      if (entity.type === 'dimension') {
        items.push({
          type: 'item',
          label: entity.isConstraint ? 'Make Driven' : 'Make Driving',
          icon: entity.isConstraint ? '📐' : '📏',
          action: () => {
            takeSnapshot();
            if (entity.isConstraint) {
              const inC = state.scene.constraints.includes(entity);
              if (inC) state.scene.removeConstraint(entity);
              entity.isConstraint = false;
            } else {
              entity.isConstraint = true;
              if (entity.sourceA && !state.scene.constraints.includes(entity)) {
                state.scene.addConstraint(entity);
              }
            }
            state.scene.solve();
            state.emit('change');
            this._scheduleRender();
          },
        });
        items.push(this._arrowStyleSubmenu([entity]));
        items.push({ type: 'separator' });
      }

      // Delete
      items.push({
        type: 'item',
        label: 'Delete',
        icon: '🗑',
        shortcut: 'Del',
        action: () => {
          takeSnapshot();
          this._deleteSelection();
        },
      });
    } else {
      // Canvas right-click (no entity)
      items.push({
        type: 'item',
        label: 'Fit All',
        icon: '⊡',
        shortcut: 'F',
        action: () => { this.viewport.fitEntities(state.entities); this._scheduleRender(); },
      });
      items.push({
        type: 'item',
        label: state.gridVisible ? 'Hide Grid' : 'Show Grid',
        icon: '#',
        shortcut: 'G',
        action: () => {
          state.gridVisible = !state.gridVisible;
          document.getElementById('btn-grid-toggle').classList.toggle('active', state.gridVisible);
          this._scheduleRender();
        },
      });
      items.push({
        type: 'item',
        label: state.snapEnabled ? 'Disable Snap' : 'Enable Snap',
        icon: '⊙',
        shortcut: 'S',
        action: () => {
          state.snapEnabled = !state.snapEnabled;
          document.getElementById('btn-snap-toggle').classList.toggle('active', state.snapEnabled);
          document.getElementById('status-snap').classList.toggle('active', state.snapEnabled);
          this._scheduleRender();
        },
      });
      items.push({
        type: 'item',
        label: state.autoCoincidence ? 'Disable Auto-Connect' : 'Enable Auto-Connect',
        icon: '⊚',
        action: () => {
          state.autoCoincidence = !state.autoCoincidence;
          document.getElementById('btn-autocoincidence-toggle').classList.toggle('active', state.autoCoincidence);
          document.getElementById('status-autocoincidence').classList.toggle('active', state.autoCoincidence);
          this._scheduleRender();
        },
      });
      items.push({ type: 'separator' });
      items.push({
        type: 'item',
        label: 'Undo',
        icon: '↩',
        shortcut: 'Ctrl+Z',
        action: () => { undo(); this._scheduleRender(); },
      });
      items.push({
        type: 'item',
        label: 'Redo',
        icon: '↪',
        shortcut: 'Ctrl+Y',
        action: () => { redo(); this._scheduleRender(); },
      });
    }

    showContextMenu(x, y, items);
  }

  // --- 3D Canvas Events ---

  /**
   * Convert screen coordinates to 2D world coordinates on the active sketch plane.
   * Uses raycasting in 3D mode, or the viewport in 2D mode.
   * @param {number} sx - screen X (relative to canvas)
   * @param {number} sy - screen Y (relative to canvas)
   * @returns {{x: number, y: number}|null}
   */
  _screenToSketchWorld(sx, sy) {
    if (this._sketchingOnPlane && this._activeSketchPlaneDef && this._renderer3d) {
      return this._renderer3d.rayToPlane(sx, sy, this._activeSketchPlaneDef);
    }
    return this.viewport.screenToWorld(sx, sy);
  }

  _bind3DCanvasEvents() {
    const canvas = this._renderer3d.renderer?.domElement;
    if (!canvas) return;
    let movedSinceDown = false;
    let mouseDown = false;

    // Mouse down
    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      movedSinceDown = false;
      mouseDown = true;

      if (!this._3dMode) {
        // 2D sketch interaction
        if (e.button === 2) {
          // Right button = pan
          e.preventDefault();
          this.viewport.startPan(sx, sy);
          return;
        }
        if (e.button === 0 && this.activeTool.onMouseDown) {
          let wx, wy;
          if (this.activeTool.freehand) {
            const raw = this.viewport.screenToWorld(sx, sy);
            wx = raw.x; wy = raw.y;
          } else {
            const basePoint = this.activeTool._startX !== undefined
              ? { x: this.activeTool._startX, y: this.activeTool._startY }
              : null;
            const { world } = getSnappedPosition(
              sx, sy, this.viewport,
              this.activeTool.step > 0 ? basePoint : null,
              { ignoreGridSnap: !!e.ctrlKey }
            );
            wx = world.x; wy = world.y;
          }
          this.activeTool.onMouseDown(wx, wy, sx, sy, e);
        }
        return;
      }

      // Middle button = orbit, Right button = pan (handled by WasmRenderer controls)
      if (e.button === 1 || e.button === 2) {
        return; // Let WASM renderer controls handle
      }

      if (e.button === 0 && this.activeTool.onMouseDown) {
        if (this._sketchingOnPlane) {
          // Raycast to sketch plane for 2D coords
          const world = this._screenToSketchWorld(sx, sy);
          if (world) this.activeTool.onMouseDown(world.x, world.y, sx, sy, e);
        } else {
          const world = this._renderer3d.screenToWorld(sx, sy);
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

      if (!this._3dMode) {
        if (this.viewport.isPanning) {
          this.viewport.updatePan(sx, sy);
          // Update cursor world position so the crosshair tracks the mouse during pan
          const world = this.viewport.screenToWorld(sx, sy);
          this.renderer.cursorWorld = world;
          this._scheduleRender();
          return;
        }
        this._lastPointer = { sx, sy, ctrlKey: e.ctrlKey };
        this._schedulePointerProcessing();
        return;
      }

      if (this._sketchingOnPlane) {
        // Sketching on plane in 3D: process pointer for sketch tools
        this._lastPointer = { sx, sy, ctrlKey: e.ctrlKey };
        this._scheduleSketchPointerProcessing();
        this._scheduleRender();
        return;
      }

      this._scheduleRender();
    });

    // Mouse up
    canvas.addEventListener('mouseup', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      mouseDown = false;

      if (!this._3dMode) {
        if (e.button === 2) {
          // Right button = end pan
          this.viewport.endPan();
          debouncedSave();
          return;
        }
        const world = this.viewport.screenToWorld(sx, sy);
        if (this.activeTool.onMouseUp) {
          this.activeTool.onMouseUp(world.x, world.y, e);
        }
        this._scheduleRender();
        return;
      }

      if (e.button === 1 || e.button === 2) {
        debouncedSave();
        return;
      }

      if (this.activeTool.onMouseUp) {
        if (this._sketchingOnPlane) {
          const world = this._screenToSketchWorld(sx, sy);
          if (world) this.activeTool.onMouseUp(world.x, world.y, e);
        } else {
          const world = this._renderer3d.screenToWorld(sx, sy);
          this.activeTool.onMouseUp(world.x, world.y, e);
        }
      }

      this._scheduleRender();
    });

    // Click
    canvas.addEventListener('click', (e) => {
      if (!this._3dMode) {
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

        if (this.activeTool.name === 'select' && this.activeTool._isDragging) return;

        this.activeTool.onClick(world.x, world.y, e);
        movedSinceDown = false;
        this._scheduleRender();
        return;
      }

      if (movedSinceDown && this.activeTool.name === 'select') {
        movedSinceDown = false;
        return;
      }
      
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (this._sketchingOnPlane) {
        // Sketching on plane in 3D: raycast to plane for click coords
        const world = this._screenToSketchWorld(sx, sy);
        if (world && this.activeTool.onClick) {
          this.activeTool.onClick(world.x, world.y, e);
        }
        movedSinceDown = false;
        this._scheduleRender();
        return;
      }

      const world = this._renderer3d.screenToWorld(sx, sy);

      // In Part mode 3D view: handle face/geometry picking
      if (this._workspaceMode === 'part' && this._renderer3d) {
        const hit = this._renderer3d.pickFace(e.clientX, e.clientY);
        if (hit) {
          this._selectedFace = hit;
          this._renderer3d.selectFace(hit.faceIndex);
          this.setStatus(`Selected face ${hit.faceIndex} (normal: ${hit.face.normal.x.toFixed(2)}, ${hit.face.normal.y.toFixed(2)}, ${hit.face.normal.z.toFixed(2)})`);
          info(`Face selected: ${hit.faceIndex}`);
        } else {
          this._selectedFace = null;
          this._renderer3d.selectFace(-1);
        }
        this._updateOperationButtons();
      }

      if (this.activeTool.onClick) {
        this.activeTool.onClick(world.x, world.y, e);
      }

      this._scheduleRender();
    });

    // Double click
    canvas.addEventListener('dblclick', (e) => {
      if (!this._3dMode) {
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const world = this.viewport.screenToWorld(sx, sy);
        const tol = 12 / this.viewport.zoom;

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
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const world = this._renderer3d.screenToWorld(sx, sy);

      if (this.activeTool.onDoubleClick) {
        this.activeTool.onDoubleClick(world.x, world.y, e);
      }

      this._scheduleRender();
    });

    // Context menu — right-click is now used for panning, so suppress
    // the browser context menu on the canvas entirely.
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    // Wheel for zooming (trigger render)
    canvas.addEventListener('wheel', (e) => {
      if (!this._3dMode) {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const sx = e.clientX - rect.left;
        const sy = e.clientY - rect.top;
        const factor = e.deltaY > 0 ? 0.9 : 1.1;
        this.viewport.zoomAt(sx, sy, factor);
        debouncedSave();
        this._scheduleRender();
        return;
      }
      // In 3D mode, WasmRenderer handles orbit zoom via its own wheel handler
      e.preventDefault();
      this._scheduleRender();
    }, { passive: false });

    canvas.addEventListener('touchstart', (e) => {
      if (this._3dMode) return;
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
      if (this._3dMode) return;
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
      e.currentTarget.classList.toggle('active', state.snapEnabled);
      document.getElementById('status-snap').classList.toggle('active', state.snapEnabled);
    });
    // Auto-connect coincidences
    document.getElementById('btn-autocoincidence-toggle').addEventListener('click', (e) => {
      state.autoCoincidence = !state.autoCoincidence;
      e.currentTarget.classList.toggle('active', state.autoCoincidence);
      document.getElementById('status-autocoincidence').classList.toggle('active', state.autoCoincidence);
    });
    document.getElementById('btn-ortho-toggle').addEventListener('click', (e) => {
      state.orthoEnabled = !state.orthoEnabled;
      e.currentTarget.classList.toggle('active', state.orthoEnabled);
      document.getElementById('status-ortho').classList.toggle('active', state.orthoEnabled);
      if (this._renderer3d) {
        this._renderer3d.setOrtho3D(state.orthoEnabled);
      }
      this._scheduleRender();
    });

    // Construction mode toggle
    document.getElementById('btn-construction').addEventListener('click', () => {
      this._toggleConstructionMode();
    });

    // Motion Analysis
    document.getElementById('btn-motion').addEventListener('click', () => {
      this._toggleMotionPanel();
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
    document.getElementById('status-autocoincidence').classList.toggle('active', state.autoCoincidence);
    document.getElementById('btn-autocoincidence-toggle').classList.toggle('active', state.autoCoincidence);
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
        case 'h': case 'H':
          if (this._tryApplyConstraintFromSelection('horizontal')) break;
          this.setActiveTool('horizontal');
          break;
        case 'v': case 'V':
          if (this._tryApplyConstraintFromSelection('vertical')) break;
          this.setActiveTool('vertical');
          break;
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
          if (this._renderer3d) {
            this._renderer3d.setOrtho3D(state.orthoEnabled);
          }
          this._scheduleRender();
          break;
        case '2':
          if (this._3dMode) this._toggle3DMode();
          break;
        case '3':
          if (!this._3dMode) this._toggle3DMode();
          break;
        case 'q': case 'Q': {
          // If primitives are selected, toggle their construction flag
          const sel = state.selectedEntities.filter(e => e.type === 'segment' || e.type === 'circle' || e.type === 'arc');
          if (sel.length > 0) {
            takeSnapshot();
            const newVal = !sel[0].construction;
            for (const e of sel) e.construction = newVal;
            state.emit('change');
            this._scheduleRender();
          } else {
            // Otherwise toggle the construction drawing mode
            this._toggleConstructionMode();
          }
          break;
        }
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
      this._sceneVersion += 1;
      this._scheduleRender();
      this._rebuildLeftPanel();
      debouncedSave();
    });
    state.on('selection:change', (sel) => {
      this._sceneVersion += 1;
      this._updatePropertiesPanel(sel);
      this._rebuildLeftPanel();
    });
    state.on('layers:change', () => {
      this._sceneVersion += 1;
      this._rebuildLayersPanel();
      debouncedSave();
    });
    state.on('file:loaded', () => {
      this._sceneVersion += 1;
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
        html += `<div class="prop-row"><label>Construction</label><span>${e.construction ? 'Yes' : 'No'}</span></div>`;
        if (e.construction) {
          const ct = e.constructionType || 'finite';
          const ctLabel = { 'finite': 'Finite', 'infinite-start': 'Inf. Start', 'infinite-end': 'Inf. End', 'infinite-both': 'Inf. Both' }[ct] || ct;
          html += `<div class="prop-row"><label>Type</label><span>${ctLabel}</span></div>`;
          const dashLabel = { 'dashed': 'Dashed', 'dash-dot': 'Dash-Dot', 'dotted': 'Dotted' }[e.constructionDash || 'dashed'] || 'Dashed';
          html += `<div class="prop-row"><label>Dash</label><span>${dashLabel}</span></div>`;
        }
        html += `<div class="prop-row"><label>X1</label><span>${e.x1.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Y1</label><span>${e.y1.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>X2</label><span>${e.x2.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Y2</label><span>${e.y2.toFixed(2)}</span></div>`;
        const len = Math.hypot(e.x2 - e.x1, e.y2 - e.y1);
        html += `<div class="prop-row"><label>Length</label><span>${len.toFixed(2)}</span></div>`;
      } else if (e.type === 'circle') {
        html += `<div class="prop-row"><label>Construction</label><span>${e.construction ? 'Yes' : 'No'}</span></div>`;
        html += `<div class="prop-row"><label>Center X</label><span>${e.cx.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Center Y</label><span>${e.cy.toFixed(2)}</span></div>`;
        html += `<div class="prop-row"><label>Radius</label><span>${e.radius.toFixed(2)}</span></div>`;
      } else if (e.type === 'arc') {
        html += `<div class="prop-row"><label>Construction</label><span>${e.construction ? 'Yes' : 'No'}</span></div>`;
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

    // Toggle all dimensions visibility
    document.getElementById('btn-toggle-all-dims').addEventListener('click', () => {
      state.allDimensionsVisible = !state.allDimensionsVisible;
      this._updateToggleAllButtons();
      this._scheduleRender();
    });

    // Toggle all constraint icons visibility
    document.getElementById('btn-toggle-all-constraints').addEventListener('click', () => {
      state.constraintIconsVisible = !state.constraintIconsVisible;
      this._updateToggleAllButtons();
      this._scheduleRender();
    });

    // Add variable button
    document.getElementById('btn-add-variable').addEventListener('click', async () => {
      const val = await showPrompt({
        title: 'Add Variable',
        message: 'Enter variable as name=value or name=formula (e.g. width=50, height=width*2):',
        defaultValue: '',
      });
      if (val !== null && val !== '') {
        const eqIdx = val.indexOf('=');
        if (eqIdx > 0) {
          const name = val.substring(0, eqIdx).trim();
          const valueStr = val.substring(eqIdx + 1).trim();
          const num = parseFloat(valueStr);
          if (name) {
            takeSnapshot();
            // Store as number if purely numeric, otherwise as formula string
            setVariable(name, isNaN(num) ? valueStr : num);
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
    this._rebuildDimensionsList();
    this._rebuildConstraintsList();
    this._rebuildVariablesList();
    this._updateToggleAllButtons();
  }

  /** Sync the toggle-all buttons' visual state with current flags */
  _updateToggleAllButtons() {
    const dimBtn = document.getElementById('btn-toggle-all-dims');
    const conBtn = document.getElementById('btn-toggle-all-constraints');
    if (dimBtn) {
      dimBtn.classList.toggle('off', !state.allDimensionsVisible);
      dimBtn.title = state.allDimensionsVisible ? 'Hide all dimensions' : 'Show all dimensions';
    }
    if (conBtn) {
      conBtn.classList.toggle('off', !state.constraintIconsVisible);
      conBtn.title = state.constraintIconsVisible ? 'Hide all constraint icons' : 'Show all constraint icons';
    }
  }

  /** Get an icon for a primitive, reflecting its visual style */
  _primIcon(prim) {
    if (typeof prim === 'string') {
      // Fallback for plain type string
      const icons = { segment: '╱', circle: '○', arc: '◠', point: '·', text: 'T', dimension: '↔' };
      return icons[prim] || '?';
    }
    const type = prim.type;
    const color = prim.construction ? '#90EE90' : '#ccc';
    const w = prim.lineWidth || 1;
    const sw = Math.min(Math.max(w, 0.5), 3); // clamp for icon display
    let dash = '';
    if (prim.construction) {
      const ds = prim.constructionDash || 'dashed';
      if (ds === 'dashed') dash = ' stroke-dasharray="4,2"';
      else if (ds === 'dash-dot') dash = ' stroke-dasharray="4,1.5,1,1.5"';
      else if (ds === 'dotted') dash = ' stroke-dasharray="1,2"';
    }
    if (type === 'segment') {
      return `<svg width="14" height="14" viewBox="0 0 14 14" style="display:block"><line x1="1" y1="13" x2="13" y2="1" stroke="${color}" stroke-width="${sw}"${dash}/></svg>`;
    }
    if (type === 'circle') {
      return `<svg width="14" height="14" viewBox="0 0 14 14" style="display:block"><circle cx="7" cy="7" r="5.5" fill="none" stroke="${color}" stroke-width="${sw}"${dash}/></svg>`;
    }
    if (type === 'arc') {
      return `<svg width="14" height="14" viewBox="0 0 14 14" style="display:block"><path d="M 2 10 A 6 6 0 0 1 12 10" fill="none" stroke="${color}" stroke-width="${sw}"${dash}/></svg>`;
    }
    const fallback = { point: '·', text: 'T', dimension: '↔' };
    return fallback[type] || '?';
  }

  /** Build a 'Line Thickness' submenu for one or more entities */
  _thicknessSubmenu(entities) {
    const thicknesses = [0.25, 0.5, 1, 1.5, 2, 3, 5];
    const current = entities[0]?.lineWidth ?? 1;
    return {
      type: 'submenu',
      label: 'Line Thickness',
      icon: '━',
      items: thicknesses.map(t => ({
        type: 'item',
        label: `${t}`,
        icon: current === t ? '✓' : '',
        labelHtml: `<span style="display:flex;align-items:center;gap:8px"><span>${t}</span><svg width="36" height="4" viewBox="0 0 36 4" style="display:block"><line x1="0" y1="2" x2="36" y2="2" stroke="#ccc" stroke-width="${Math.min(t * 1.5, 4)}"/></svg></span>`,
        action: () => {
          takeSnapshot();
          for (const e of entities) e.lineWidth = t;
          state.emit('change');
          this._scheduleRender();
        },
      })),
    };
  }

  /** Build an 'Arrow Style' submenu for dimensions */
  _arrowStyleSubmenu(dims) {
    const current = dims[0]?.arrowStyle || 'auto';
    const styles = [
      { key: 'auto', label: 'Automatic' },
      { key: 'inside', label: 'Inside' },
      { key: 'outside', label: 'Outside' },
      { key: 'none', label: 'None' },
    ];
    return {
      type: 'submenu',
      label: 'Arrow Style',
      icon: '⟷',
      items: styles.map(s => ({
        type: 'item',
        label: s.label,
        icon: current === s.key ? '✓' : '',
        action: () => {
          takeSnapshot();
          for (const d of dims) d.arrowStyle = s.key;
          state.emit('change');
          this._scheduleRender();
        },
      })),
    };
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
    const allShapes = [...scene.shapes()].filter(s => s.type !== 'dimension');

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
      if (prim.construction) {
        const ct = prim.constructionType || 'finite';
        const ctTag = ct === 'finite' ? 'C' : ct === 'infinite-start' ? 'C←' : ct === 'infinite-end' ? 'C→' : 'C↔';
        const ds = prim.constructionDash || 'dashed';
        const dsTag = ds === 'dashed' ? '' : ds === 'dash-dot' ? ', ─·' : ', ···';
        desc += ` <span style="opacity:0.5;color:#90EE90">(${ctTag}${dsTag})</span>`;
      }
      if (prim.lineWidth !== 1) {
        desc += ` <span style="opacity:0.4;font-size:10px">[${prim.lineWidth}]</span>`;
      }

      const iconHtml = this._primIcon(prim);
      const isHtml = iconHtml.startsWith('<');
      row.innerHTML = `<span class="lp-icon">${isHtml ? '' : iconHtml}</span><span class="lp-label">${desc}</span>`;
      if (isHtml) row.querySelector('.lp-icon').innerHTML = iconHtml;

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

      // Right-click context menu
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Select if not already
        if (!prim.selected) {
          state.clearSelection();
          state.select(prim);
          this._scheduleRender();
        }
        const isShape = prim.type === 'segment' || prim.type === 'circle' || prim.type === 'arc';
        const ctxItems = [];
        if (isShape) {
          ctxItems.push({
            type: 'item',
            label: prim.construction ? 'Make Normal' : 'Make Construction',
            icon: prim.construction ? '━' : '┄',
            shortcut: 'Q',
            action: () => {
              takeSnapshot();
              prim.construction = !prim.construction;
              state.emit('change');
              this._scheduleRender();
            },
          });
          if (prim.type === 'segment' && prim.construction) {
            const currentType = prim.constructionType || 'finite';
            ctxItems.push({
              type: 'submenu',
              label: 'Construction Type',
              icon: '⇔',
              items: [
                { key: 'finite', label: 'Finite' },
                { key: 'infinite-start', label: 'Infinite Start' },
                { key: 'infinite-end', label: 'Infinite End' },
                { key: 'infinite-both', label: 'Infinite Both' },
              ].map(opt => ({
                type: 'item',
                label: opt.label,
                icon: currentType === opt.key ? '✓' : '',
                action: () => { takeSnapshot(); prim.constructionType = opt.key; state.emit('change'); this._scheduleRender(); },
              })),
            });
          }
          if (prim.construction) {
            const currentDash = prim.constructionDash || 'dashed';
            const dashArrays = { 'dashed': '6,4', 'dash-dot': '6,3,1,3', 'dotted': '1.5,3' };
            const dashLabels = { 'dashed': 'Dashed', 'dash-dot': 'Dash-Dot', 'dotted': 'Dotted' };
            ctxItems.push({
              type: 'submenu',
              label: 'Dash Style',
              icon: '┄',
              items: Object.keys(dashArrays).map(key => ({
                type: 'item',
                label: dashLabels[key],
                icon: currentDash === key ? '✓' : '',
                labelHtml: `<span style="display:flex;align-items:center;gap:10px"><span>${dashLabels[key]}</span><svg width="40" height="2" viewBox="0 0 40 2" style="display:block"><line x1="0" y1="1" x2="40" y2="1" stroke="#ccc" stroke-width="1.5" stroke-dasharray="${dashArrays[key]}"/></svg></span>`,
                action: () => { takeSnapshot(); prim.constructionDash = key; state.emit('change'); this._scheduleRender(); },
              })),
            });
          }
          ctxItems.push(this._thicknessSubmenu([prim]));
          ctxItems.push({ type: 'separator' });
        }
        ctxItems.push({
          type: 'item',
          label: 'Delete',
          icon: '🗑',
          shortcut: 'Del',
          action: () => { takeSnapshot(); this._deleteSelection(); },
        });
        showContextMenu(e.clientX, e.clientY, ctxItems);
      });

      list.appendChild(row);
    }
  }

  _rebuildDimensionsList() {
    const list = document.getElementById('dimensions-list');
    list.innerHTML = '';
    const scene = state.scene;
    const dims = scene.dimensions;

    if (dims.length === 0) {
      list.innerHTML = '<p class="hint">No dimensions</p>';
      return;
    }

    for (const dim of dims) {
      const row = document.createElement('div');
      row.className = 'lp-item';
      row.dataset.primId = dim.id;
      row.dataset.primType = 'dimension';

      if (dim.selected) row.classList.add('selected');

      const hoverEnt = this.renderer.hoverEntity;
      if (hoverEnt && hoverEnt.id === dim.id) row.classList.add('highlight');

      if (this._lpHoverConstraintId != null) {
        const hc = scene.constraints.find(c => c.id === this._lpHoverConstraintId);
        if (hc && this._constraintPrimIds(hc).has(dim.id)) {
          row.classList.add('highlight');
        }
      }

      const dimT = dim.dimType || 'distance';
      const desc = `Dimension #${dim.id}`;
      const statusLabel = dim.isConstraint ? 'driving' : 'driven';
      const eyeIcon = dim.visible ? '👁' : '—';

      row.innerHTML = `<span class="lp-icon">↔</span>` +
        `<span class="lp-label">${desc} <span style="opacity:0.5">(${dimT}, ${statusLabel})</span></span>` +
        `<button class="lp-eye" title="Toggle visibility">${eyeIcon}</button>`;

      // Eye toggle
      row.querySelector('.lp-eye').addEventListener('click', (e) => {
        e.stopPropagation();
        dim.visible = !dim.visible;
        this._rebuildDimensionsList();
        this._scheduleRender();
      });

      // Mouse events for cross-highlighting
      row.addEventListener('mouseenter', () => {
        this._lpHoverPrimId = dim.id;
        this.renderer.hoverEntity = dim;
        this._scheduleRender();
        this._updateLeftPanelHighlights();
      });
      row.addEventListener('mouseleave', () => {
        this._lpHoverPrimId = null;
        if (this.renderer.hoverEntity === dim) this.renderer.hoverEntity = null;
        this._scheduleRender();
        this._updateLeftPanelHighlights();
      });

      // Click to select/deselect
      row.addEventListener('click', (e) => {
        if (e.target.classList.contains('lp-eye')) return;
        if (!e.shiftKey) state.clearSelection();
        if (dim.selected && e.shiftKey) {
          state.deselect(dim);
        } else {
          state.select(dim);
        }
        this._scheduleRender();
      });

      // Right-click context menu
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!dim.selected) {
          state.clearSelection();
          state.select(dim);
          this._scheduleRender();
        }
        const ctxItems = [];
        ctxItems.push({
          type: 'item',
          label: dim.visible ? 'Hide' : 'Show',
          icon: dim.visible ? '—' : '👁',
          action: () => { dim.visible = !dim.visible; this._rebuildDimensionsList(); this._scheduleRender(); },
        });
        ctxItems.push({
          type: 'item',
          label: dim.isConstraint ? 'Make Driven' : 'Make Driving',
          icon: dim.isConstraint ? '📐' : '📏',
          action: () => {
            takeSnapshot();
            if (dim.isConstraint) {
              // Remove from constraints
              const inC = state.scene.constraints.includes(dim);
              if (inC) state.scene.removeConstraint(dim);
              dim.isConstraint = false;
            } else {
              // Make a constraint
              dim.isConstraint = true;
              if (dim.sourceA && !state.scene.constraints.includes(dim)) {
                state.scene.addConstraint(dim);
              }
            }
            state.scene.solve();
            state.emit('change');
            this._scheduleRender();
          },
        });
        ctxItems.push({
          type: 'item',
          label: 'Edit',
          icon: '✎',
          action: () => { this._editDimensionConstraint(dim); },
        });
        ctxItems.push(this._arrowStyleSubmenu([dim]));
        ctxItems.push({ type: 'separator' });
        ctxItems.push({
          type: 'item',
          label: 'Delete',
          icon: '🗑',
          shortcut: 'Del',
          action: () => { takeSnapshot(); this._deleteSelection(); },
        });
        showContextMenu(e.clientX, e.clientY, ctxItems);
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

      // Right-click context menu
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        this._lpSelectedConstraintId = c.id;
        this._updateLeftPanelHighlights();
        const ctxItems = [];
        if (c.editable) {
          ctxItems.push({
            type: 'item',
            label: 'Edit',
            icon: '✎',
            action: () => { this._editConstraint(c); },
          });
        }
        ctxItems.push({
          type: 'item',
          label: 'Delete',
          icon: '🗑',
          shortcut: 'Del',
          action: () => {
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
          },
        });
        showContextMenu(e.clientX, e.clientY, ctxItems);
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

    for (const [name, rawValue] of vars) {
      const row = document.createElement('div');
      row.className = 'lp-item';

      // Compute resolved value for display
      const isFormula = typeof rawValue === 'string';
      const resolved = isFormula ? resolveValue(rawValue) : rawValue;
      const displayValue = isFormula
        ? `${rawValue} = ${isNaN(resolved) ? '?' : resolved.toFixed(4)}`
        : rawValue;

      row.innerHTML = `<span class="lp-icon" style="color:var(--accent)">𝑥</span>` +
        `<span class="lp-var-name">${name}</span>` +
        `<span class="lp-var-eq">=</span>` +
        `<span class="lp-var-value">${displayValue}</span>` +
        `<button class="lp-edit" title="Edit variable (name &amp; value)">✎</button>` +
        `<button class="lp-delete" title="Delete variable">✕</button>`;

      // --- Inline value edit: click on the value span ---
      const valueSpan = row.querySelector('.lp-var-value');
      valueSpan.addEventListener('click', (e) => {
        e.stopPropagation();
        this._inlineEditVariableValue(row, name, rawValue);
      });

      // --- Inline name edit: double-click on the name span ---
      const nameSpan = row.querySelector('.lp-var-name');
      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        this._inlineEditVariableName(row, name, rawValue);
      });

      // --- Edit button: full popup for name=value ---
      row.querySelector('.lp-edit').addEventListener('click', async () => {
        const val = await showPrompt({
          title: 'Edit Variable',
          message: `Edit variable (name=value or name=formula):`,
          defaultValue: `${name}=${rawValue}`,
        });
        if (val !== null && val !== '') {
          const eqIdx = val.indexOf('=');
          if (eqIdx > 0) {
            const newName = val.substring(0, eqIdx).trim();
            const valueStr = val.substring(eqIdx + 1).trim();
            const num = parseFloat(valueStr);
            if (newName) {
              takeSnapshot();
              if (newName !== name) {
                this._renameVariableEverywhere(name, newName);
              }
              setVariable(newName, isNaN(num) ? valueStr : num);
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

      // Right-click context menu
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const ctxItems = [];
        ctxItems.push({
          type: 'item',
          label: 'Rename',
          icon: '✎',
          action: () => { this._inlineEditVariableName(row, name, rawValue); },
        });
        ctxItems.push({
          type: 'item',
          label: 'Edit Value',
          icon: '=',
          action: () => { this._inlineEditVariableValue(row, name, rawValue); },
        });
        ctxItems.push({ type: 'separator' });
        ctxItems.push({
          type: 'item',
          label: 'Delete',
          icon: '🗑',
          action: () => {
            takeSnapshot();
            removeVariable(name);
            state.scene.solve();
            state.emit('change');
            this._scheduleRender();
          },
        });
        showContextMenu(e.clientX, e.clientY, ctxItems);
      });

      list.appendChild(row);
    }
  }

  /**
   * Rename a variable everywhere in the project:
   * - The variables map itself
   * - All constraint .value properties that reference it (by name or in formulas)
   * - All dimension .formula and .variableName properties
   * - All other variable values that are formulas referencing the old name
   */
  _renameVariableEverywhere(oldName, newName) {
    if (oldName === newName) return;
    const value = getVariableRaw(oldName);
    removeVariable(oldName);
    setVariable(newName, value);

    // Regex to match whole-word occurrences of oldName in formula strings
    const re = new RegExp('\\b' + oldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');

    // Update constraints that reference this variable
    for (const c of state.scene.constraints) {
      if (c.value !== undefined) {
        if (typeof c.value === 'string') {
          if (c.value === oldName) {
            c.value = newName;
          } else {
            c.value = c.value.replace(re, newName);
          }
        }
      }
      // Dimension constraints (duck-typed)
      if (c.formula !== undefined && typeof c.formula === 'string') {
        if (c.formula === oldName) {
          c.formula = newName;
        } else {
          c.formula = c.formula.replace(re, newName);
        }
      }
      if (c.variableName !== undefined && c.variableName === oldName) {
        c.variableName = newName;
      }
    }

    // Update dimensions that aren't in the constraints list (driven dimensions)
    for (const dim of state.scene.dimensions) {
      if (state.scene.constraints.includes(dim)) continue; // already handled
      if (typeof dim.formula === 'string') {
        if (dim.formula === oldName) {
          dim.formula = newName;
        } else {
          dim.formula = dim.formula.replace(re, newName);
        }
      }
      if (dim.variableName === oldName) {
        dim.variableName = newName;
      }
    }

    // Update other variables whose values are formulas referencing the old name
    for (const [vName, vVal] of getAllVariables()) {
      if (vName === newName) continue; // skip the renamed variable itself
      if (typeof vVal === 'string') {
        if (vVal === oldName) {
          setVariable(vName, newName);
        } else {
          const updated = vVal.replace(re, newName);
          if (updated !== vVal) setVariable(vName, updated);
        }
      }
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
        const valueStr = input.value.trim();
        const num = parseFloat(valueStr);
        const newValue = isNaN(num) ? valueStr : num;
        if (newValue !== currentValue) {
          takeSnapshot();
          setVariable(name, newValue);
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
          this._renameVariableEverywhere(currentName, newName);
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

    // Update dimensions list highlights
    const dimItems = document.querySelectorAll('#dimensions-list .lp-item');
    for (const item of dimItems) {
      const id = parseInt(item.dataset.primId);
      let hl = false;

      if (hoverEnt && hoverEnt.id === id) hl = true;
      if (hcPrimIds && hcPrimIds.has(id)) hl = true;

      item.classList.toggle('highlight', hl);

      const prim = shapesById.get(id);
      item.classList.toggle('selected', prim ? prim.selected : false);
    }

    // Scroll highlighted items into view
    const highlightedPrim = document.querySelector('#primitives-list .lp-item.highlight');
    if (highlightedPrim) highlightedPrim.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    const highlightedDim = document.querySelector('#dimensions-list .lp-item.highlight');
    if (highlightedDim) highlightedDim.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
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

  // =====================================================================
  //  Motion Analysis
  // =====================================================================

  _toggleMotionPanel() {
    const panel = document.getElementById('motion-panel');
    const isOpen = panel.style.display !== 'none';
    if (isOpen) {
      this._closeMotionPanel();
    } else {
      this._openMotionPanel();
    }
  }

  _openMotionPanel() {
    if (motionAnalysis.isRunning) {
      // If analysis is running, just show the panel
      document.getElementById('motion-panel').style.display = '';
      document.getElementById('btn-motion').classList.add('active');
      this._adjustCanvasForMotion();
      return;
    }

    // Switch to select tool
    this.setActiveTool('select');

    // Show the panel
    const panel = document.getElementById('motion-panel');
    const setup = document.getElementById('motion-setup');
    const playback = document.getElementById('motion-playback');
    panel.style.display = '';
    setup.style.display = '';
    playback.style.display = 'none';
    document.getElementById('motion-export-csv').style.display = 'none';
    document.getElementById('btn-motion').classList.add('active');

    // Populate driver dropdown
    this._motionPopulateDrivers();

    // Clear probes
    this._motionProbes = [];
    this._motionRebuildProbes();

    this._adjustCanvasForMotion();
  }

  _closeMotionPanel() {
    if (motionAnalysis.isRunning) {
      motionAnalysis.stop();
      state.selectedEntities = [];
      state.emit('change');
    }
    // Stop playback animation
    if (this._motionAnimId) {
      cancelAnimationFrame(this._motionAnimId);
      this._motionAnimId = null;
    }
    this._motionPlaying = false;

    document.getElementById('motion-panel').style.display = 'none';
    document.getElementById('btn-motion').classList.remove('active');
    document.body.classList.remove('motion-active');
    // Restore viewport area
    document.getElementById('cad-canvas').style.bottom = '';
    const view3d = document.getElementById('view-3d');
    if (view3d) view3d.style.bottom = '';
    this.viewport.resize();
    this._scheduleRender();
  }

  _adjustCanvasForMotion() {
    requestAnimationFrame(() => {
      const panel = document.getElementById('motion-panel');
      const h = panel.offsetHeight;
      document.body.classList.add('motion-active');
      document.body.style.setProperty('--motion-panel-h', h + 'px');
      document.getElementById('cad-canvas').style.bottom = (56 + h) + 'px';
      const view3d = document.getElementById('view-3d');
      if (view3d) view3d.style.bottom = (56 + h) + 'px';
      this.viewport.resize();
      this._scheduleRender();
    });
  }

  _motionPopulateDrivers() {
    const sel = document.getElementById('motion-driver');
    sel.innerHTML = '<option value="">— Select a driving dimension, constraint, or variable —</option>';
    const scene = state.scene;

    // Driving dimensions (isConstraint && formula != null)
    for (const dim of scene.dimensions) {
      if (dim.isConstraint && dim.formula != null) {
        const label = `Dim #${dim.id}: ${dim.dimType} = ${dim.displayLabel}`;
        const opt = document.createElement('option');
        opt.value = `dim:${dim.id}`;
        opt.textContent = label;
        sel.appendChild(opt);
      }
    }

    // Editable constraints (Distance, Length, Angle, Radius, Fixed)
    for (const c of scene.constraints) {
      if (c.editable && c.type !== 'dimension') {
        let label = `${c.type} #${c.id}`;
        if (c.value !== undefined) label += ` = ${typeof c.value === 'number' ? c.value.toFixed(2) : c.value}`;
        const opt = document.createElement('option');
        opt.value = `con:${c.id}`;
        opt.textContent = label;
        sel.appendChild(opt);
      }
    }

    // Variables
    for (const [name, raw] of getAllVariables()) {
      const resolved = getVariable(name);
      const showResolved = typeof resolved === 'number' && !isNaN(resolved);
      const rawText = typeof raw === 'number' ? raw.toFixed(4) : String(raw);
      const label = showResolved
        ? `Var ${name} = ${resolved.toFixed(4)} (${rawText})`
        : `Var ${name} = ${rawText}`;
      const opt = document.createElement('option');
      opt.value = `var:${name}`;
      opt.textContent = label;
      sel.appendChild(opt);
    }
  }

  _motionGetSelectedDriver() {
    const val = document.getElementById('motion-driver').value;
    if (!val) return null;
    const scene = state.scene;
    if (val.startsWith('dim:')) {
      const id = parseInt(val.slice(4));
      return { target: scene.dimensions.find(d => d.id === id), driverType: 'dim' };
    } else if (val.startsWith('con:')) {
      const id = parseInt(val.slice(4));
      return { target: scene.constraints.find(c => c.id === id), driverType: 'con' };
    } else if (val.startsWith('var:')) {
      const name = val.slice(4);
      return { target: name, driverType: 'var' };
    }
    return null;
  }

  _motionRebuildProbes() {
    const container = document.getElementById('motion-probes');
    container.innerHTML = '';
    const scene = state.scene;

    for (let i = 0; i < this._motionProbes.length; i++) {
      const probe = this._motionProbes[i];
      const row = document.createElement('div');
      row.className = 'motion-probe-row';

      const typeSpan = document.createElement('span');
      typeSpan.className = 'motion-probe-type';
      typeSpan.textContent = probe.type === 'point' ? 'PT' : 'DIM';

      const select = document.createElement('select');
      if (probe.type === 'point') {
        for (const p of scene.points) {
          const opt = document.createElement('option');
          opt.value = p.id;
          opt.textContent = `Point #${p.id} (${p.x.toFixed(1)}, ${p.y.toFixed(1)})`;
          if (probe._targetId === p.id) opt.selected = true;
          select.appendChild(opt);
        }
      } else {
        for (const d of scene.dimensions) {
          const opt = document.createElement('option');
          opt.value = d.id;
          opt.textContent = `Dim #${d.id}: ${d.dimType} = ${d.displayLabel}`;
          if (probe._targetId === d.id) opt.selected = true;
          select.appendChild(opt);
        }
      }
      select.addEventListener('change', () => {
        probe._targetId = parseInt(select.value);
        if (probe.type === 'point') {
          probe.target = scene.points.find(p => p.id === probe._targetId);
          probe.label = `P${probe._targetId}`;
        } else {
          probe.target = scene.dimensions.find(d => d.id === probe._targetId);
          probe.label = `D${probe._targetId}`;
        }
      });

      const removeBtn = document.createElement('button');
      removeBtn.className = 'motion-probe-remove';
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => {
        this._motionProbes.splice(i, 1);
        this._motionRebuildProbes();
      });

      row.appendChild(typeSpan);
      row.appendChild(select);
      row.appendChild(removeBtn);
      container.appendChild(row);

      // Auto-select first item if not set
      if (!probe._targetId && select.options.length > 0) {
        select.dispatchEvent(new Event('change'));
      }
    }
  }

  _bindMotionEvents() {
    this._motionProbes = [];
    this._motionPlaying = false;
    this._motionAnimId = null;
    this._motionSpeed = 1;

    // Close
    document.getElementById('motion-close').addEventListener('click', () => {
      this._closeMotionPanel();
    });

    // Driver selection — auto-populate from/to
    document.getElementById('motion-driver').addEventListener('change', () => {
      const info = this._motionGetSelectedDriver();
      if (info && info.target) {
        let currentVal;
        if (info.driverType === 'dim') {
          currentVal = info.target.value;
        } else if (info.driverType === 'con') {
          currentVal = typeof info.target.value === 'number' ? info.target.value : resolveValue(info.target.value);
        } else {
          currentVal = getVariable(info.target);
        }
        if (typeof currentVal === 'number' && !isNaN(currentVal)) {
          document.getElementById('motion-from').value = currentVal.toFixed(4);
          // Suggest a range: ±50% or ±20 for small values
          const range = Math.max(Math.abs(currentVal) * 0.5, 20);
          document.getElementById('motion-to').value = (currentVal + range).toFixed(4);
        }
      }
    });

    // Add probes
    document.getElementById('motion-add-point-probe').addEventListener('click', () => {
      const scene = state.scene;
      if (scene.points.length === 0) return;
      const first = scene.points[0];
      this._motionProbes.push({
        type: 'point',
        target: first,
        _targetId: first.id,
        label: `P${first.id}`,
      });
      this._motionRebuildProbes();
    });

    document.getElementById('motion-add-dim-probe').addEventListener('click', () => {
      const scene = state.scene;
      if (scene.dimensions.length === 0) return;
      const first = scene.dimensions[0];
      this._motionProbes.push({
        type: 'dimension',
        target: first,
        _targetId: first.id,
        label: `D${first.id}`,
      });
      this._motionRebuildProbes();
    });

    // Run Analysis
    document.getElementById('motion-run').addEventListener('click', () => {
      const driverInfo = this._motionGetSelectedDriver();
      if (!driverInfo || !driverInfo.target) {
        this.setStatus('Motion: Select a driver first');
        return;
      }
      const from = parseFloat(document.getElementById('motion-from').value);
      const to = parseFloat(document.getElementById('motion-to').value);
      const steps = parseInt(document.getElementById('motion-steps').value) || 50;
      if (isNaN(from) || isNaN(to)) {
        this.setStatus('Motion: Invalid from/to values');
        return;
      }

      const driver = driverInfo.target;

      const config = {
        driver: driver,
        from, to, steps,
        probes: this._motionProbes.filter(p => p.target),
        _driverType: driverInfo.driverType,
      };

      if (driverInfo.driverType === 'var') {
        config._driverName = driver;
      } else {
        config._driverId = driver.id;
      }

      // Tag probes with IDs for re-linking
      for (const p of config.probes) {
        p._targetId = p.target.id;
      }

      this.setStatus(`Motion: Running analysis (${steps} steps)...`);
      // Use setTimeout to allow UI to update before blocking
      setTimeout(() => {
        const result = motionAnalysis.run(config);
        if (!result.ok) {
          this.setStatus(`Motion Error: ${result.error}`);
          return;
        }

        // Switch to playback view
        document.getElementById('motion-setup').style.display = 'none';
        document.getElementById('motion-playback').style.display = '';
        document.getElementById('motion-export-csv').style.display = '';

        const slider = document.getElementById('motion-slider');
        slider.max = motionAnalysis.frames.length - 1;
        slider.value = 0;

        this._motionUpdateDisplay(0);
        this._adjustCanvasForMotion();
        this.setStatus(`Motion: Analysis complete — ${motionAnalysis.frames.length} frames`);
        this._scheduleRender();
      }, 50);
    });

    // Playback slider
    document.getElementById('motion-slider').addEventListener('input', (e) => {
      const t = parseFloat(e.target.value);
      motionAnalysis.seekSmooth(t);
      this._motionUpdateDisplay(t);
      this._scheduleRender();
    });

    // Play / Pause
    document.getElementById('motion-play').addEventListener('click', () => {
      this._motionPlaying = !this._motionPlaying;
      document.getElementById('motion-play').textContent = this._motionPlaying ? '⏸' : '▶';
      if (this._motionPlaying) this._motionAnimate();
    });

    // Speed
    document.getElementById('motion-speed').addEventListener('input', (e) => {
      this._motionSpeed = parseFloat(e.target.value) || 1;
      document.getElementById('motion-speed-label').textContent = this._motionSpeed.toFixed(1) + '×';
    });

    // Stop — back to setup
    document.getElementById('motion-stop').addEventListener('click', () => {
      motionAnalysis.stop();
      state.selectedEntities = [];
      state.emit('change');

      if (this._motionAnimId) {
        cancelAnimationFrame(this._motionAnimId);
        this._motionAnimId = null;
      }
      this._motionPlaying = false;

      // Back to setup
      document.getElementById('motion-setup').style.display = '';
      document.getElementById('motion-playback').style.display = 'none';
      document.getElementById('motion-export-csv').style.display = 'none';
      document.getElementById('motion-play').textContent = '▶';
      this._motionPopulateDrivers();
      this._motionRebuildProbes();
      this._adjustCanvasForMotion();
      this._scheduleRender();
    });

    // Export CSV
    document.getElementById('motion-export-csv').addEventListener('click', () => {
      const csv = motionAnalysis.exportCSV();
      if (!csv) return;
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'motion_analysis.csv';
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  _motionUpdateDisplay(t) {
    const total = motionAnalysis.frames.length - 1;
    const frameIdx = Math.round(t);
    document.getElementById('motion-frame-info').textContent = `${frameIdx} / ${total}`;
    document.getElementById('motion-slider').value = t;

    const driverVal = motionAnalysis.getDriverValueAt(t);
    document.getElementById('motion-driver-value').textContent = driverVal.toFixed(4);

    // Probe output
    const probeVals = motionAnalysis.getProbeValuesAt(t);
    const output = document.getElementById('motion-probe-output');
    output.innerHTML = '';
    for (const [key, val] of Object.entries(probeVals)) {
      const item = document.createElement('span');
      item.className = 'motion-probe-output-item';
      item.innerHTML = `<span class="probe-label">${key}:</span> <span class="probe-value">${val.toFixed(4)}</span>`;
      output.appendChild(item);
    }
  }

  _motionAnimate() {
    if (!this._motionPlaying || !motionAnalysis.isRunning) return;

    const total = motionAnalysis.frames.length - 1;
    if (total <= 0) return;

    let lastTime = performance.now();
    const step = () => {
      if (!this._motionPlaying || !motionAnalysis.isRunning) return;

      const now = performance.now();
      const dt = (now - lastTime) / 1000; // seconds
      lastTime = now;

      // Advance by speed * frames-per-second-equivalent
      const slider = document.getElementById('motion-slider');
      let t = parseFloat(slider.value) + dt * this._motionSpeed * 10; // ~10 frames/sec at 1x speed

      // Loop
      if (t > total) t = 0;

      motionAnalysis.seekSmooth(t);
      this._motionUpdateDisplay(t);
      this._scheduleRender();

      this._motionAnimId = requestAnimationFrame(step);
    };
    this._motionAnimId = requestAnimationFrame(step);
  }

  // --- 3D View Events ---
  _bind3DEvents() {
    // Initialize 3D panels
    const featurePanelContainer = document.getElementById('feature-panel');
    const parametersPanelContainer = document.getElementById('parameters-panel');
    
    this._featurePanel = new FeaturePanel(featurePanelContainer, this._partManager);
    this._parametersPanel = new ParametersPanel(parametersPanelContainer, this._partManager);

    // Setup callbacks
    this._featurePanel.setOnFeatureSelect((feature) => {
      this._parametersPanel.showFeature(feature);
    });

    this._featurePanel.setOnFeatureToggle((feature) => {
      this._update3DView();
    });

    this._featurePanel.setOnFeatureDelete((featureId) => {
      this._parametersPanel.clear();
      this._update3DView();
    });

    // Listen to part changes
    this._partManager.addListener((part) => {
      this._featurePanel.update();
      this._updateNodeTree();
      this._update3DView();
      this._updateOperationButtons();
    });

    // 3D Mode Toggle
    const btn3DMode = document.getElementById('btn-3d-mode');
    if (!this._renderer3d) {
      btn3DMode.disabled = true;
      btn3DMode.title = '3D unavailable: WebGL2 is not supported in this browser context';
    }
    btn3DMode.addEventListener('click', () => {
      this._toggle3DMode();
    });

    // Add Sketch to Part
    document.getElementById('btn-add-sketch').addEventListener('click', (e) => {
      if (this._selectedFace && this._selectedFace.face) {
        // Use selected face's plane
        const planeDef = this._getPlaneFromFace(this._selectedFace);
        if (planeDef) {
          this._addSketchToPartWithPlane(planeDef);
          this._selectedFace = null;
          if (this._renderer3d) this._renderer3d.selectFace(-1);
          return;
        }
      }
      if (this._selectedPlane) {
        // Use pre-selected plane directly
        this._addSketchToPart(this._selectedPlane);
      } else {
        // Show plane selector context menu near the button
        const btn = e.currentTarget;
        const rect = btn.getBoundingClientRect();
        showContextMenu(rect.left, rect.bottom + 2, [
          { type: 'item', label: 'XY Plane', icon: '▬', action: () => this._addSketchToPart('XY') },
          { type: 'item', label: 'XZ Plane', icon: '▬', action: () => this._addSketchToPart('XZ') },
          { type: 'item', label: 'YZ Plane', icon: '▬', action: () => this._addSketchToPart('YZ') },
        ]);
      }
    });

    // Extrude
    document.getElementById('btn-extrude').addEventListener('click', async () => {
      const distance = await showPrompt({
        title: 'Extrude',
        message: 'Enter extrusion distance:',
        defaultValue: '10',
      });
      
      if (distance && !isNaN(parseFloat(distance))) {
        this._extrudeSketch(parseFloat(distance));
      }
    });

    // Revolve
    document.getElementById('btn-revolve').addEventListener('click', async () => {
      const angle = await showPrompt({
        title: 'Revolve',
        message: 'Enter angle in degrees (360 for full):',
        defaultValue: '360',
      });
      
      if (angle && !isNaN(parseFloat(angle))) {
        const radians = (parseFloat(angle) * Math.PI) / 180;
        this._revolveSketch(radians);
      }
    });
  }

  _toggle3DMode() {
    if (!this._renderer3d) {
      this._3dMode = false;
      this.setStatus('3D mode unavailable in this browser context (WebGL2 missing).');
      return;
    }

    // If currently sketching on a plane, toggle only affects camera projection
    // (perspective ↔ ortho) without leaving sketch mode
    if (this._sketchingOnPlane) {
      state.orthoEnabled = !state.orthoEnabled;
      this._renderer3d.setOrtho3D(state.orthoEnabled);
      const orthoBtn = document.getElementById('btn-ortho');
      if (orthoBtn) orthoBtn.classList.toggle('active', state.orthoEnabled);
      this._scheduleRender();
      return;
    }

    this._3dMode = !this._3dMode;
    const featurePanel = document.getElementById('feature-panel');
    const parametersPanel = document.getElementById('parameters-panel');
    const btn = document.getElementById('btn-3d-mode');
    const modeIndicator = document.getElementById('status-mode');

    if (this._3dMode) {
      // Enter 3D viewing mode (perspective camera)
      this._renderer3d.setMode('3d');
      this._renderer3d.setVisible(true);
      // Clear any leftover sketch plane reference so axes don't persist
      this._renderer3d._sketchPlane = null;
      this._renderer3d._sketchPlaneDef = null;
      featurePanel.classList.add('active');
      parametersPanel.classList.add('active');
      btn.classList.add('active');
      document.body.classList.add('mode-3d');

      // Update mode indicator based on workspace
      if (this._workspaceMode === 'part') {
        modeIndicator.textContent = 'PART';
        modeIndicator.className = 'status-mode part-mode';
      } else {
        modeIndicator.textContent = '3D VIEW';
        modeIndicator.className = 'status-mode view-3d-mode';
      }

      // Switch to select tool (drawing tools are hidden in 3D)
      this.setActiveTool('select');
      
      info('3D viewing mode activated');
    } else {
      // Return to 2D sketching mode (orthographic camera)
      this._renderer3d.setMode('2d');
      this._renderer3d.setVisible(true);
      this._renderer3d.sync2DView(this.viewport);
      featurePanel.classList.remove('active');
      parametersPanel.classList.remove('active');
      btn.classList.remove('active');
      document.body.classList.remove('mode-3d');

      // Update mode indicator based on workspace
      if (this._workspaceMode === 'part') {
        modeIndicator.textContent = 'PART 2D';
        modeIndicator.className = 'status-mode part-mode';
      } else {
        modeIndicator.textContent = 'SKETCH';
        modeIndicator.className = 'status-mode sketch-mode';
      }
      
      info('2D sketching mode activated');
    }
    
    this._update3DView();
    this._updateOperationButtons();
  }

  _addSketchToPart(planeName = 'XY') {
    if (state.entities.length === 0) {
      this.setStatus('Draw something in 2D first before adding to part');
      return;
    }

    // Build plane definition from plane name
    const planeDef = this._getPlaneDefinition(planeName);
    const sketchFeature = this._partManager.addSketchFromScene(
      state.scene,
      `Sketch${this._partManager.getFeatures().length + 1}`,
      planeDef
    );
    this._lastSketchFeatureId = sketchFeature.id;
    
    this._featurePanel.update();
    this._updateNodeTree();
    this._update3DView();
    this._updateOperationButtons();
    
    this.setStatus(`Added sketch feature: ${sketchFeature.name} on ${planeName} plane`);
    info(`Created sketch feature: ${sketchFeature.id} on ${planeName} plane`);
  }

  /**
   * Add a sketch to the part using an explicit plane definition (e.g., from a face).
   * @param {Object} planeDef - Plane definition with origin, normal, xAxis, yAxis
   */
  _addSketchToPartWithPlane(planeDef) {
    if (state.entities.length === 0) {
      this.setStatus('Draw something in 2D first before adding to part');
      return;
    }

    const sketchFeature = this._partManager.addSketchFromScene(
      state.scene,
      `Sketch${this._partManager.getFeatures().length + 1}`,
      planeDef
    );
    this._lastSketchFeatureId = sketchFeature.id;

    this._featurePanel.update();
    this._updateNodeTree();
    this._update3DView();
    this._updateOperationButtons();

    this.setStatus(`Added sketch feature: ${sketchFeature.name} on face plane`);
    info(`Created sketch feature: ${sketchFeature.id} on face plane`);
  }

  /**
   * Convert a plane name to a plane definition object.
   * @param {'XY'|'XZ'|'YZ'} name
   * @returns {Object} plane definition with origin, normal, xAxis, yAxis
   */
  _getPlaneDefinition(name) {
    switch (name) {
      case 'XZ':
        return {
          origin: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 1, z: 0 },
          xAxis:  { x: 1, y: 0, z: 0 },
          yAxis:  { x: 0, y: 0, z: 1 },
        };
      case 'YZ':
        return {
          origin: { x: 0, y: 0, z: 0 },
          normal: { x: 1, y: 0, z: 0 },
          xAxis:  { x: 0, y: 1, z: 0 },
          yAxis:  { x: 0, y: 0, z: 1 },
        };
      case 'XY':
      default:
        return {
          origin: { x: 0, y: 0, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
          xAxis:  { x: 1, y: 0, z: 0 },
          yAxis:  { x: 0, y: 1, z: 0 },
        };
    }
  }

  _extrudeSketch(distance) {
    if (!this._lastSketchFeatureId) {
      this.setStatus('Add a sketch to the part first');
      return;
    }

    const feature = this._partManager.extrude(this._lastSketchFeatureId, distance);
    
    this._featurePanel.update();
    this._updateNodeTree();
    this._update3DView();
    
    this.setStatus(`Extruded sketch: ${distance} units`);
    info(`Created extrude feature: ${feature.id}`);
  }

  _revolveSketch(angle) {
    if (!this._lastSketchFeatureId) {
      this.setStatus('Add a sketch to the part first');
      return;
    }

    const feature = this._partManager.revolve(this._lastSketchFeatureId, angle);
    
    this._featurePanel.update();
    this._updateNodeTree();
    this._update3DView();
    
    const degrees = (angle * 180 / Math.PI).toFixed(1);
    this.setStatus(`Revolved sketch: ${degrees}°`);
    info(`Created revolve feature: ${feature.id}`);
  }

  _update3DView() {
    if (!this._renderer3d || !this._3dMode) return;

    const part = this._partManager.getPart();
    if (!part) {
      this._renderer3d.clearPartGeometry();
      this._renderer3d.sync2DView(this.viewport);
      this._renderer3d.render2DScene(state.scene, {
        sceneVersion: this._sceneVersion,
        hoverEntity: this.renderer.hoverEntity,
        previewEntities: this.renderer.previewEntities,
        snapPoint: this.renderer.snapPoint,
        cursorWorld: this.renderer.cursorWorld,
        isLayerVisible: (layer) => state.isLayerVisible(layer),
        getLayerColor: (layer) => state.getLayerColor(layer),
        allDimensionsVisible: state.allDimensionsVisible,
        constraintIconsVisible: state.constraintIconsVisible,
      });
      return;
    }

    try {
      const hadGeometry = this._renderer3d._meshTriangles != null;
      this._renderer3d.renderPart(part);
      // Only auto-fit the camera when geometry first appears; subsequent
      // updates preserve the user's camera orientation and zoom.
      if (!hadGeometry && this._renderer3d._meshTriangles) {
        this._renderer3d.fitToView();
      }
    } catch (err) {
      error('Failed to render 3D part:', err);
      this.setStatus('Error rendering 3D part');
    }
  }

  _updateNodeTree() {
    const container = document.getElementById('node-tree-features');
    if (!container) return;
    
    const features = this._partManager.getFeatures();
    container.innerHTML = '';

    // Show origin planes with visibility toggles
    const part = this._partManager.getPart();
    if (part) {
      const originPlanes = part.getOriginPlanes();
      ['XY', 'XZ', 'YZ'].forEach((planeName) => {
        const planeState = originPlanes[planeName];
        const div = document.createElement('div');
        div.className = 'node-tree-item node-tree-plane';
        div.setAttribute('data-plane', planeName);
        if (this._selectedPlane === planeName) div.classList.add('selected');
        
        const eyeIcon = planeState.visible ? '◉' : '○';
        div.innerHTML = `<span class="node-tree-eye" data-plane-toggle="${planeName}" title="Toggle ${planeName} plane visibility">${eyeIcon}</span><span class="node-tree-icon" style="color:#87CEEB">▬</span><span class="node-tree-label">${planeName} Plane</span>`;
        
        // Toggle visibility on eye icon click
        const eyeEl = div.querySelector('.node-tree-eye');
        eyeEl.addEventListener('click', (e) => {
          e.stopPropagation();
          part.setOriginPlaneVisible(planeName, !planeState.visible);
          this._updateNodeTree();
          this._update3DView();
          this._scheduleRender();
        });

        // Select plane on row click
        div.addEventListener('click', () => {
          if (this._workspaceMode !== 'part') return;
          if (this._selectedPlane === planeName) {
            this._selectedPlane = null;
            div.classList.remove('selected');
          } else {
            container.querySelectorAll('.node-tree-plane').forEach(p => p.classList.remove('selected'));
            this._selectedPlane = planeName;
            div.classList.add('selected');
          }
        });
        
        container.appendChild(div);
      });
    }

    // Show custom planes if any
    const customPlanes = part ? part.getCustomPlanes() : [];
    if (customPlanes.length > 0) {
      customPlanes.forEach((plane) => {
        const div = document.createElement('div');
        div.className = 'node-tree-item node-tree-plane';
        div.innerHTML = `<span class="node-tree-icon" style="color:#ffaa44">▬</span><span class="node-tree-label">${plane.name}</span>`;
        container.appendChild(div);
      });
    }
    
    if (features.length === 0) return;

    const featureIcons = {
      'sketch': '📐',
      'extrude': '⬆️',
      'revolve': '🔄',
      'fillet': '🔘',
      'chamfer': '📐'
    };

    features.forEach((feature) => {
      const div = document.createElement('div');
      div.className = 'node-tree-feature';
      if (feature.suppressed) div.classList.add('suppressed');
      if (this._featurePanel && this._featurePanel.selectedFeatureId === feature.id) {
        div.classList.add('active');
      }
      
      const icon = featureIcons[feature.type] || '📦';
      const visIcon = feature.visible ? '' : ' <span class="node-tree-hidden-indicator" title="Hidden">[hidden]</span>';
      div.innerHTML = `<span class="node-tree-icon">${icon}</span><span class="node-tree-label">${feature.name}${visIcon}</span>`;
      
      div.addEventListener('click', () => {
        if (this._featurePanel) {
          this._featurePanel.selectFeature(feature.id);
        }
        this._updateNodeTree();
      });
      
      container.appendChild(div);
    });
  }

  _updateOperationButtons() {
    const hasSketch = this._lastSketchFeatureId !== null;
    const hasEntities = state.entities.length > 0;
    
    document.getElementById('btn-add-sketch').disabled = !hasEntities || !this._3dMode;
    document.getElementById('btn-extrude').disabled = !hasSketch || !this._3dMode;
    document.getElementById('btn-revolve').disabled = !hasSketch || !this._3dMode;
  }

  // --- Quick-Start Page ---

  _showQuickStart() {
    const qs = document.getElementById('quick-start');
    if (qs) qs.classList.remove('hidden');
  }

  _hideQuickStart() {
    const qs = document.getElementById('quick-start');
    if (qs) qs.classList.add('hidden');
  }

  _bindQuickStartEvents() {
    const qsSketch = document.getElementById('qs-sketch');
    const qsPart = document.getElementById('qs-part');
    const qsAssembly = document.getElementById('qs-assembly');

    if (qsSketch) {
      qsSketch.addEventListener('click', () => {
        this._enterWorkspace('sketch');
      });
    }

    if (qsPart) {
      qsPart.addEventListener('click', () => {
        this._enterWorkspace('part');
      });
    }

    if (qsAssembly) {
      qsAssembly.addEventListener('click', () => {
        // Assembly is a stub - show message
        this.setStatus('Assembly workspace is coming soon.');
      });
    }
  }

  _enterWorkspace(mode) {
    this._workspaceMode = mode;
    this._hideQuickStart();

    // Remove any previous workspace class
    document.body.classList.remove('workspace-sketch', 'workspace-part');
    document.body.classList.add(`workspace-${mode}`);

    const modeIndicator = document.getElementById('status-mode');

    if (mode === 'sketch') {
      // Sketch workspace: 2D mode, all sketch tools available
      this._3dMode = false;
      if (this._renderer3d) {
        this._renderer3d.setMode('2d');
        this._renderer3d.setVisible(true);
      }
      document.body.classList.remove('mode-3d');
      modeIndicator.textContent = 'SKETCH';
      modeIndicator.className = 'status-mode sketch-mode';
      this.setActiveTool('select');
      info('Entered Sketch workspace');
    } else if (mode === 'part') {
      // Part workspace: Start in 3D mode with Part tools
      this._partManager.createPart('Part1');
      this._3dMode = true;
      if (this._renderer3d) {
        this._renderer3d.setMode('3d');
        this._renderer3d.setVisible(true);
      }
      document.body.classList.add('mode-3d');
      const featurePanel = document.getElementById('feature-panel');
      const parametersPanel = document.getElementById('parameters-panel');
      featurePanel.classList.add('active');
      parametersPanel.classList.add('active');
      document.getElementById('btn-3d-mode').classList.add('active');
      modeIndicator.textContent = 'PART';
      modeIndicator.className = 'status-mode part-mode';
      this.setActiveTool('select');
      this._updateOperationButtons();
      this._updateNodeTree();
      info('Entered Part workspace');
    }
    this._scheduleRender();
  }

  // --- Plane Selection Events ---

  _bindPlaneSelectionEvents() {
    const planeItems = document.querySelectorAll('.node-tree-plane[data-plane]');
    planeItems.forEach((item) => {
      item.addEventListener('click', () => {
        if (this._workspaceMode !== 'part') return;
        const plane = item.getAttribute('data-plane');
        if (this._selectedPlane === plane) {
          // Deselect
          this._selectedPlane = null;
          item.classList.remove('selected');
        } else {
          // Deselect previous
          planeItems.forEach(p => p.classList.remove('selected'));
          // Select new
          this._selectedPlane = plane;
          item.classList.add('selected');
        }
        info(`Plane selection: ${this._selectedPlane || 'none'}`);
        this._update3DView();
        this._scheduleRender();
      });
    });
  }

  // --- Exit Sketch Button ---

  _bindExitSketchButton() {
    const btn = document.getElementById('btn-exit-sketch');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!this._sketchingOnPlane) return;

      const hasEntities = state.entities.length > 0;
      if (hasEntities) {
        const save = await showConfirm({
          title: 'Exit Sketch',
          message: 'Save sketch changes to the part?',
          okText: 'Save & Exit',
          cancelText: 'Discard',
        });
        if (save) {
          this._finishSketchOnPlane();
        } else {
          this._discardSketchOnPlane();
        }
      } else {
        // Nothing drawn, just exit
        this._discardSketchOnPlane();
      }
    });
  }

  /**
   * Discard the current sketch-on-plane and return to Part 3D mode
   * without saving anything.
   */
  _discardSketchOnPlane() {
    if (!this._sketchingOnPlane) return;

    // Clear the active sketch on the part
    const part = this._partManager.getPart();
    if (part) part.setActiveSketch(null);

    // Clear the 2D scene (discard drawings)
    state.scene.clear();
    state.selectedEntities = [];

    // Return to 3D Part mode
    this._sketchingOnPlane = false;
    this._activeSketchPlane = null;
    this._activeSketchPlaneDef = null;
    this._3dMode = true;

    document.body.classList.remove('sketch-on-plane');
    const exitBtn = document.getElementById('btn-exit-sketch');
    if (exitBtn) exitBtn.style.display = 'none';

    if (this._renderer3d) {
      this._renderer3d._sketchPlane = null;
      this._renderer3d._sketchPlaneDef = null;
      this._renderer3d.setMode('3d');
      this._renderer3d.setVisible(true);
    }

    document.body.classList.add('mode-3d');
    document.getElementById('btn-3d-mode').classList.add('active');

    const modeIndicator = document.getElementById('status-mode');
    modeIndicator.textContent = 'PART';
    modeIndicator.className = 'status-mode part-mode';

    this.setActiveTool('select');
    this._update3DView();
    this._updateOperationButtons();
    this.setStatus('Sketch discarded. Returned to Part 3D mode.');
    info('Discarded sketch-on-plane, returned to Part 3D mode');
    this._scheduleRender();
  }

  // --- Part Mode Tool Events ---

  _bindPartToolEvents() {
    const btnCreatePlane = document.getElementById('btn-create-plane');
    const btnSketchOnPlane = document.getElementById('btn-sketch-on-plane');
    const btnExtrudePart = document.getElementById('btn-extrude-part');
    const btnExtrudeCut = document.getElementById('btn-extrude-cut');

    if (btnCreatePlane) {
      btnCreatePlane.addEventListener('click', () => {
        this._startCreatePlane();
      });
    }

    if (btnSketchOnPlane) {
      btnSketchOnPlane.addEventListener('click', () => {
        // If a face is selected, use its plane
        if (this._selectedFace && this._selectedFace.face) {
          this._startSketchOnFace(this._selectedFace);
        } else {
          this._startSketchOnPlane();
        }
      });
    }

    if (btnExtrudePart) {
      btnExtrudePart.addEventListener('click', async () => {
        await this._startExtrude(false);
      });
    }

    if (btnExtrudeCut) {
      btnExtrudeCut.addEventListener('click', async () => {
        await this._startExtrude(true);
      });
    }
  }

  async _startCreatePlane() {
    if (this._workspaceMode !== 'part') {
      this.setStatus('Create Plane is only available in Part workspace.');
      return;
    }

    // Prompt for plane parameters
    const offset = await showPrompt({
      title: 'Create Plane',
      message: 'Enter offset distance from the reference plane (XY):',
      defaultValue: '0',
    });

    if (offset === null || offset === undefined) return;

    const offsetVal = parseFloat(offset) || 0;

    const rotU = await showPrompt({
      title: 'Create Plane – Rotation U',
      message: 'Enter rotation around U-axis (degrees):',
      defaultValue: '0',
    });

    if (rotU === null || rotU === undefined) return;

    const rotV = await showPrompt({
      title: 'Create Plane – Rotation V',
      message: 'Enter rotation around V-axis (degrees):',
      defaultValue: '0',
    });

    if (rotV === null || rotV === undefined) return;

    const rotUVal = parseFloat(rotU) || 0;
    const rotVVal = parseFloat(rotV) || 0;

    // Store the plane definition in the part using public API
    const part = this._partManager.getPart();
    if (!part) this._partManager.createPart('Part1');
    const activePart = this._partManager.getPart();

    const existingPlanes = activePart.getCustomPlanes();
    const planeId = `plane_${existingPlanes.length + 1}`;
    const planeDef = {
      id: planeId,
      name: `Plane ${existingPlanes.length + 1}`,
      offset: offsetVal,
      rotationU: rotUVal,
      rotationV: rotVVal,
      basePlane: 'XY',
    };

    activePart.addCustomPlane(planeDef);
    this._updateNodeTree();
    this.setStatus(`Created plane: ${planeDef.name} (offset: ${offsetVal}, rotU: ${rotUVal}°, rotV: ${rotVVal}°)`);
    info(`Created custom plane: ${planeId}`);
  }

  _startSketchOnPlane(planeName) {
    if (this._workspaceMode !== 'part') {
      this.setStatus('Sketch on Plane is only available in Part workspace.');
      return;
    }

    // If no plane specified and none pre-selected, show a picker
    const plane = planeName || this._selectedPlane;
    if (!plane) {
      const btn = document.getElementById('btn-sketch-on-plane');
      const rect = btn.getBoundingClientRect();
      showContextMenu(rect.left, rect.bottom + 2, [
        { type: 'item', label: 'XY Plane', icon: '▬', action: () => this._startSketchOnPlane('XY') },
        { type: 'item', label: 'XZ Plane', icon: '▬', action: () => this._startSketchOnPlane('XZ') },
        { type: 'item', label: 'YZ Plane', icon: '▬', action: () => this._startSketchOnPlane('YZ') },
      ]);
      return;
    }

    // Clear the 2D scene so each sketch starts fresh
    state.scene.clear();
    state.selectedEntities = [];

    // Stay in 3D mode but enable sketch-on-plane
    this._sketchingOnPlane = true;
    this._activeSketchPlane = plane;
    this._activeSketchPlaneDef = this._getPlaneDefinition(plane);
    this._3dMode = true;

    // Add sketch-on-plane body class to control UI visibility
    document.body.classList.add('sketch-on-plane');

    // Show Exit Sketch button
    const exitBtn = document.getElementById('btn-exit-sketch');
    if (exitBtn) exitBtn.style.display = 'flex';

    if (this._renderer3d) {
      // Orient camera perpendicular to the selected plane
      this._renderer3d.orientToPlane(plane);
      // Stay in 3D mode so the mesh remains visible
      this._renderer3d.setMode('3d');
      this._renderer3d.setVisible(true);
      // Tell renderer which sketch plane we're on (for colored reference axes)
      this._renderer3d._sketchPlane = plane;
      // Store plane definition for screen projection of sketch entities
      this._renderer3d._sketchPlaneDef = this._activeSketchPlaneDef;
    }

    // Keep mode-3d class since we're in 3D
    document.body.classList.add('mode-3d');
    document.getElementById('btn-3d-mode').classList.add('active');

    const modeIndicator = document.getElementById('status-mode');
    modeIndicator.textContent = `SKETCH ON ${plane}`;
    modeIndicator.className = 'status-mode sketch-mode';

    this.setActiveTool('select');
    this.setStatus(`Sketching on ${plane} plane. Draw your profile, then Exit Sketch to extrude.`);
    info(`Entered sketch-on-plane mode (${plane} plane)`);
    this._scheduleRender();
  }

  /**
   * Start sketching on a selected 3D face. Derives the plane from the face normal.
   * @param {Object} faceHit - Face hit from pickFace() with face and point
   */
  _startSketchOnFace(faceHit) {
    if (this._workspaceMode !== 'part') return;
    if (!faceHit || !faceHit.face) return;

    const planeDef = this._getPlaneFromFace(faceHit);
    if (!planeDef) return;

    // Clear the 2D scene so each sketch starts fresh
    state.scene.clear();
    state.selectedEntities = [];

    // Store the face-derived plane definition for raycasting
    this._activeSketchPlaneDef = planeDef;

    // Orient camera perpendicular to the face normal
    if (this._renderer3d) {
      this._renderer3d.orientToPlaneNormal(faceHit.face.normal, faceHit.point);
    }

    // Stay in 3D mode but enable sketch-on-plane
    this._sketchingOnPlane = true;
    this._activeSketchPlane = 'FACE';
    this._3dMode = true;

    document.body.classList.add('sketch-on-plane');

    const exitBtn = document.getElementById('btn-exit-sketch');
    if (exitBtn) exitBtn.style.display = 'flex';

    if (this._renderer3d) {
      // Stay in 3D mode so the mesh remains visible
      this._renderer3d.setMode('3d');
      this._renderer3d.setVisible(true);
      this._renderer3d._sketchPlane = 'FACE';
      // Store plane definition for screen projection of sketch entities
      this._renderer3d._sketchPlaneDef = this._activeSketchPlaneDef;
    }

    // Clear face selection
    this._selectedFace = null;
    if (this._renderer3d) this._renderer3d.selectFace(-1);

    // Keep mode-3d class since we're in 3D
    document.body.classList.add('mode-3d');
    document.getElementById('btn-3d-mode').classList.add('active');

    const modeIndicator = document.getElementById('status-mode');
    modeIndicator.textContent = 'SKETCH ON FACE';
    modeIndicator.className = 'status-mode sketch-mode';

    this.setActiveTool('select');
    this.setStatus('Sketching on face. Draw your profile, then Exit Sketch to extrude.');
    info('Entered sketch-on-face mode');
    this._scheduleRender();
  }

  /**
   * Derive a plane definition from a face hit result.
   * @param {Object} faceHit - Result from pickFace()
   * @returns {Object} Plane definition with origin, normal, xAxis, yAxis
   */
  _getPlaneFromFace(faceHit) {
    const normal = faceHit.face.normal;
    const origin = faceHit.point;

    // Build xAxis perpendicular to normal
    // Choose a reference vector that's not parallel to normal
    let ref = { x: 0, y: 0, z: 1 };
    const dot = Math.abs(normal.x * ref.x + normal.y * ref.y + normal.z * ref.z);
    if (dot > 0.9) ref = { x: 1, y: 0, z: 0 };

    // xAxis = normalize(ref × normal)
    const xAxis = {
      x: ref.y * normal.z - ref.z * normal.y,
      y: ref.z * normal.x - ref.x * normal.z,
      z: ref.x * normal.y - ref.y * normal.x,
    };
    const xLen = Math.sqrt(xAxis.x * xAxis.x + xAxis.y * xAxis.y + xAxis.z * xAxis.z);
    if (xLen < 1e-10) return null;
    xAxis.x /= xLen; xAxis.y /= xLen; xAxis.z /= xLen;

    // yAxis = normalize(normal × xAxis)
    const yAxis = {
      x: normal.y * xAxis.z - normal.z * xAxis.y,
      y: normal.z * xAxis.x - normal.x * xAxis.z,
      z: normal.x * xAxis.y - normal.y * xAxis.x,
    };
    const yLen = Math.sqrt(yAxis.x * yAxis.x + yAxis.y * yAxis.y + yAxis.z * yAxis.z);
    if (yLen < 1e-10) return null;
    yAxis.x /= yLen; yAxis.y /= yLen; yAxis.z /= yLen;

    return { origin, normal, xAxis, yAxis };
  }

  _finishSketchOnPlane() {
    if (!this._sketchingOnPlane) return;

    // Clear the active sketch on the part
    const part = this._partManager.getPart();
    if (part) part.setActiveSketch(null);

    // Add the current 2D scene as a sketch feature on the active plane
    if (state.entities.length > 0) {
      if (this._activeSketchPlane === 'FACE' && this._activeSketchPlaneDef) {
        // Use the face-derived plane definition
        this._addSketchToPartWithPlane(this._activeSketchPlaneDef);
      } else {
        this._addSketchToPart(this._activeSketchPlane || 'XY');
      }
    }

    // Clear the 2D scene after saving so the next sketch starts fresh
    state.scene.clear();
    state.selectedEntities = [];

    // Return to 3D Part mode
    this._sketchingOnPlane = false;
    this._activeSketchPlane = null;
    this._activeSketchPlaneDef = null;
    this._3dMode = true;

    // Remove sketch-on-plane body class, hide Exit Sketch button
    document.body.classList.remove('sketch-on-plane');
    const exitBtn = document.getElementById('btn-exit-sketch');
    if (exitBtn) exitBtn.style.display = 'none';

    if (this._renderer3d) {
      this._renderer3d._sketchPlane = null;
      this._renderer3d._sketchPlaneDef = null;
      this._renderer3d.setMode('3d');
      this._renderer3d.setVisible(true);
    }

    document.body.classList.add('mode-3d');
    document.getElementById('btn-3d-mode').classList.add('active');

    const modeIndicator = document.getElementById('status-mode');
    modeIndicator.textContent = 'PART';
    modeIndicator.className = 'status-mode part-mode';

    this.setActiveTool('select');
    this._update3DView();
    this._updateOperationButtons();
    this.setStatus('Returned to Part 3D mode.');
    info('Finished sketch-on-plane, returned to Part 3D mode');
    this._scheduleRender();
  }

  async _startExtrude(isCut = false) {
    if (this._workspaceMode !== 'part') {
      this.setStatus('Extrude is only available in Part workspace.');
      return;
    }

    if (!this._lastSketchFeatureId) {
      this.setStatus('Create a sketch first before extruding.');
      return;
    }

    const opName = isCut ? 'Extrude Cut' : 'Extrude';

    const distance = await showPrompt({
      title: opName,
      message: `Enter ${opName.toLowerCase()} distance:`,
      defaultValue: '10',
    });

    if (distance === null || distance === undefined) return;
    const distVal = parseFloat(distance);
    if (isNaN(distVal) || distVal === 0) {
      this.setStatus('Invalid distance value.');
      return;
    }

    const absDistance = Math.abs(distVal);
    const feature = this._partManager.extrude(this._lastSketchFeatureId, absDistance);
    if (feature) {
      if (isCut) {
        // Extrude cut: reverse direction and set subtract operation
        feature.direction = -1;
        feature.operation = 'subtract';
      }

      // If a face is selected, override the extrusion direction to be perpendicular to it
      if (this._selectedFace && this._selectedFace.face) {
        const faceNormal = this._selectedFace.face.normal;
        // Update the sketch feature's plane normal to match the face
        const sketchFeature = this._partManager.getPart().getFeature(this._lastSketchFeatureId);
        if (sketchFeature && sketchFeature.type === 'sketch') {
          const planeDef = this._getPlaneFromFace(this._selectedFace);
          if (planeDef) {
            sketchFeature.setPlane(planeDef);
          }
        }
        // Clear face selection after use
        this._selectedFace = null;
        if (this._renderer3d) this._renderer3d.selectFace(-1);
      }
    }

    this._featurePanel.update();
    this._updateNodeTree();
    this._update3DView();
    this._updateOperationButtons();

    this.setStatus(`${opName}: ${absDistance} units`);
    info(`Created ${opName.toLowerCase()} feature: ${feature ? feature.id : 'failed'}`);
  }
}


// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  window.cadApp = new App();
});

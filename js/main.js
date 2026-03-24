// js/main.js — Application entry point
import { state } from './state.js';
import { Viewport } from './viewport.js';
import { WasmRenderer } from './wasm-renderer.js';
import { PartManager } from './part-manager.js';
import { FeaturePanel } from './ui/featurePanel.js';
import { ParametersPanel } from './ui/parametersPanel.js';
import { getFeatureIconSVG } from './ui/featureIcons.js';
import { getSnappedPosition } from './snap.js';
import { undo, redo, takeSnapshot, setPartManager } from './history.js';
import { downloadDXF, downloadFacesDXF } from './dxf/export.js';
import { openDXFFile, pickDXFFile, addDXFToScene, dxfBounds } from './dxf/import.js';
import { downloadCMOD, openCMODFile, projectFromCMOD, setCmodViewport, setCmodPartManager, setCmodRenderer, setCmodWorkspaceModeGetter, setCmodSessionStateGetter, setCmodScenesGetter } from './cmod.js';
import { debug, info, warn, error } from './logger.js';
import { loadProject, debouncedSave, clearSavedProject, setViewport, setPartManagerForPersist, setRendererForPersist, setWorkspaceModeGetter, setSessionStateGetter, setScenesGetter } from './persist.js';
import { showConfirm, showPrompt, showDimensionInput, isModalOpen } from './ui/popup.js';
import { DxfExportPanel } from './ui/dxfExportPanel.js';
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
import { InteractionRecorder, PlaybackEngine } from './interaction-recorder.js';
import { applyChamfer, applyFillet, expandPathEdgeKeys, makeEdgeKey, calculateMeshVolume, calculateBoundingBox, calculateSurfaceArea, detectDisconnectedBodies, calculateWallThickness, countInvertedFaces } from './cad/CSG.js';

const DIAGNOSTIC_HATCH_STORAGE_KEY = 'cad-modeller-diagnostic-backface-hatch';
const DIAGNOSTIC_HATCH_MODE_AUTO = 'auto';
const DIAGNOSTIC_HATCH_MODE_ON = 'on';
const DIAGNOSTIC_HATCH_MODE_OFF = 'off';
const RECORDING_BAR_VISIBLE_KEY = 'cad-modeller-recording-bar-visible';
const COMMAND_BAR_VISIBLE_KEY = 'cad-modeller-command-bar-visible';

class App {
  constructor() {
    info('App initialization started');
    this._renderer3d = null;
    this._workspaceMode = null; // 'part' | null (quick-start)
    this._sketchingOnPlane = false; // true when in sketch-on-plane mode inside Part workspace
    this._activeSketchPlane = null; // plane reference for current sketch
    this._selectedPlane = null; // currently selected plane in Part mode ('XY', 'XZ', 'YZ', or null)
    this._hoveredPlane = null;  // currently hovered plane in 3D viewport
    this._selectedFaces = new Map(); // faceIndex → hit object for multi-face selection
    this._savedOrbitState = null; // saved camera state before entering sketch mode
    this._expandedFolders = new Set(); // track expanded feature tree folders
    this._editingSketchFeatureId = null; // ID of sketch being edited (null = creating new)
    this._recorder = new InteractionRecorder(); // interaction recorder for workflow debugging
    this._extrudeMode = null; // active extrude mode state {isCut, sketchFeatureId, distance, direction, symmetric, operation}
    this._chamferMode = null; // active chamfer mode state {edgeKeys[], distance, editingFeatureId}
    this._filletMode = null;  // active fillet mode state {edgeKeys[], radius, segments, editingFeatureId}
    this._dxfExportPanel = null;  // DXF export sidebar panel instance
    this._awaitingSketchPlane = false; // true when waiting for user to pick a plane/face for sketch
    this._draggingExtrudeHandle = false;
    this._extrudeHandleInfo = null; // {origin, tip, dir} for drag handle
    this._extrudeArrowHoveredState = false;
    this._diagnosticBackfaceHatchMode = this._loadDiagnosticBackfaceHatchMode();
    this._diagnosticBackfaceHatchAuto = false;
    this._scenes = []; // named camera presets for repeatable renders
    this._sceneManagerOpen = false;
    this._recordingBarVisible = localStorage.getItem(RECORDING_BAR_VISIBLE_KEY) === 'true';
    this._commandBarVisible = localStorage.getItem(COMMAND_BAR_VISIBLE_KEY) === 'true';

    /** Returns true when any feature-editing mode is active (sketch, extrude, chamfer, fillet) */
    this._isEditingFeature = () => !!(this._sketchingOnPlane || this._extrudeMode || this._chamferMode || this._filletMode);
    
    // Initialize unified 3D renderer
    const view3dContainer = document.getElementById('view-3d');
    this._renderer3d = new WasmRenderer(view3dContainer);
    this._renderer3d.setMode('2d'); // Start in 2D sketching mode
    this._renderer3d.setVisible(true);
    this._renderer3d.setDiagnosticBackfaceHatchEnabled(this._effectiveDiagnosticBackfaceHatchEnabled());
    if (this._renderer3d._loadPromise) {
      this._renderer3d._loadPromise.then(() => {
        this._update3DView();
        this._scheduleRender();
      });
    }
    
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
    this._3dMode = true; // Always in unified 3D+sketch mode
    this._partManager = new PartManager();
    setPartManager(this._partManager);
    this._featurePanel = null;
    this._parametersPanel = null;
    this._lastSketchFeatureId = null;
    this._rollbackIndex = -1; // -1 means no rollback (all features active)

    // Bind events
    this._bind3DCanvasEvents(); // 3D-only interactions
    this._bindToolbarEvents();
    this._bindMenuBarEvents();
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
    this._bindExitExtrudeButton();
    this._bindRecordingControls();
    this._bindSceneManagerEvents();
    this._syncDiagnosticHatchUI();
    this._applyBarVisibility();

    // Register viewport, part manager, renderer, and workspace mode for persistence
    setViewport(this.viewport);
    setPartManagerForPersist(this._partManager);
    setRendererForPersist(this._renderer3d);
    setWorkspaceModeGetter(() => this._workspaceMode);
    setSessionStateGetter(() => this._serializeSessionState());
    setScenesGetter(() => this._scenes);

    // Register the same singletons for .cmod export/import
    setCmodViewport(this.viewport);
    setCmodPartManager(this._partManager);
    setCmodRenderer(this._renderer3d);
    setCmodWorkspaceModeGetter(() => this._workspaceMode);
    setCmodSessionStateGetter(() => this._serializeSessionState());
    setCmodScenesGetter(() => this._scenes);

    this._setStartupLoading(true, 'Loading renderer and project state...', 20);

    const loaded = loadProject();
    if (loaded && loaded.ok) {
      this._setStartupLoading(true, 'Restoring saved project...', 45);
      this._rebuildLayersPanel();
      this._rebuildLeftPanel();
      if (!loaded.hasViewport && state.entities.length > 0) {
        this.viewport.fitEntities(state.entities);
      }

      // Restore Part state if saved
      if (loaded.part && loaded.workspaceMode === 'part') {
        this._partManager.deserialize(loaded.part);
        this._enterWorkspace('part');
        if (loaded.sessionState) {
          this._restoreSessionState(loaded.sessionState);
        }
        // Restore orbit camera (skip if sketch mode — normal view was set by restore)
        if (loaded.orbit && this._renderer3d && !this._sketchingOnPlane) {
          this._renderer3d.setOrbitState(loaded.orbit);
        }
        // Restore named scenes
        if (loaded.scenes) this._scenes = loaded.scenes;
        this._setStartupLoading(true, 'Preparing part workspace...', 72);
        const readyPromise = this._renderer3d && this._renderer3d._loadPromise
          ? this._renderer3d._loadPromise
          : Promise.resolve();
        readyPromise.then(() => {
          this._update3DView();
          this._updateNodeTree();
          this._scheduleRender();
          this._setStartupLoading(true, 'Workspace restored.', 100);
          requestAnimationFrame(() => this._setStartupLoading(false));
          info('App initialization completed (restored Part workspace)');
        });
        return;
      }
    }

    // Show quick-start page on startup
    this._setStartupLoading(false);
    this._showQuickStart();

    // Initial render
    this._scheduleRender();
    info('App initialization completed');
  }

  // --- Rendering ---
  _syncFovSlider(degrees) {
    const slider = document.getElementById('fov-slider');
    const label = document.getElementById('fov-value');
    // Reverse-map: 0→0, 5..120 → 1..116
    const raw = degrees <= 0 ? 0 : Math.max(1, degrees - 4);
    if (slider) slider.value = raw;
    if (label) label.textContent = degrees === 0 ? 'Ortho' : degrees + '\u00b0';
  }

  _scheduleRender() {
    // Sync locked state on feature tree immediately (no wait for render)
    this._syncFeatureTreeLocked();

    this._renderRequested = true;
    if (this._renderScheduled) return;

    this._renderScheduled = true;

    const runRender = () => {
      this._renderScheduled = false;
      if (!this._renderRequested) return;
      this._renderRequested = false;

      this._syncViewportSize();
      try {
        // Unified rendering: always render both 2D sketch entities and 3D part geometry together
        if (this._sketchingOnPlane || state.entities.length > 0) {
          // Render 2D sketch content overlaid on 3D
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
            activeTool: this.activeTool,
          });
        } else {
          // No sketch entities: clear stale 2D overlays
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

  /** Sync the locked/unlocked visual state on both feature trees */
  _syncFeatureTreeLocked() {
    const locked = this._isEditingFeature();
    const treeEl = document.getElementById('node-tree');
    if (treeEl) treeEl.classList.toggle('locked', locked);
    if (this._featurePanel) this._featurePanel.container.classList.toggle('locked', locked);
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
   * Uses rayToPlane instead of 2D viewport screenToWorld, with full
   * snap, freehand, and ortho constraint support matching 2D behaviour.
   */
  _scheduleSketchPointerProcessing() {
    if (this._pointerFramePending || !this._lastPointer) return;
    this._pointerFramePending = true;
    requestAnimationFrame(() => {
      this._pointerFramePending = false;
      if (!this._lastPointer) return;
      const { sx, sy, ctrlKey } = this._lastPointer;
      const t0 = performance.now();

      let world, snap;
      const sketchVP = this._getSketchViewport();
      if (this.activeTool.freehand) {
        world = this._screenToSketchWorld(sx, sy);
        snap = null;
      } else if (sketchVP) {
        const basePoint = this.activeTool._startX !== undefined && this.activeTool.step > 0
          ? { x: this.activeTool._startX, y: this.activeTool._startY }
          : null;
        const result = getSnappedPosition(
          sx, sy, sketchVP, basePoint,
          { ignoreGridSnap: !!ctrlKey }
        );
        world = result.world;
        snap = result.snap;
      } else {
        world = this._screenToSketchWorld(sx, sy);
        snap = null;
      }
      if (!world) return;

      this.renderer.cursorWorld = world;
      this.renderer.snapPoint = snap;

      const display = snap || world;
      document.getElementById('status-coords').textContent =
        `X: ${display.x.toFixed(2)}  Y: ${display.y.toFixed(2)}`;

      this.activeTool.onMouseMove(world.x, world.y, sx, sy);
      this._updateLeftPanelHighlights();

      const dt = performance.now() - t0;
      if (dt > 12) {
        warn('Sketch pointer processing frame is slow', { ms: dt.toFixed(2), tool: this.activeTool.name });
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
    // Block tool changes during motion playback (except select)
    if (motionAnalysis.isRunning && name !== 'select') return;
    // Block drawing/editing tools when not in sketch-on-plane mode
    // (user must enter a sketch on a plane first to use drawing tools)
    if (this._workspaceMode === 'part' && !this._sketchingOnPlane && name !== 'select') {
      this.setStatus('Enter a sketch on a plane first to use drawing tools.');
      return;
    }
    if (this.activeTool) this.activeTool.deactivate();
    this.activeTool = this.tools[name] || this.tools.select;
    this.activeTool.activate();
    state.setTool(name);
    info('Tool changed', name);
    this._recorder.toolActivated(name);
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
    this._recorder.settingToggled('construction', state.constructionMode);
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

  /**
   * Create a viewport adapter for the snap system when sketching on a plane
   * in 3D mode. This bridges the 3D renderer's rayToPlane/sketchToScreen
   * with the 2D snap infrastructure so that grid snap, entity snap, origin
   * snap and ortho constraints work seamlessly during 3D sketch operations.
   * @returns {{screenToWorld: Function, worldToScreen: Function}|null}
   */
  _getSketchViewport() {
    if (!this._sketchingOnPlane || !this._activeSketchPlaneDef || !this._renderer3d) return null;
    const renderer = this._renderer3d;
    const planeDef = this._activeSketchPlaneDef;
    return {
      screenToWorld: (sx, sy) => renderer.rayToPlane(sx, sy, planeDef),
      worldToScreen: (wx, wy) => renderer.sketchToScreen(wx, wy),
    };
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

      // Middle button = orbit, Right button = pan (handled by WasmRenderer controls)
      if (e.button === 1 || e.button === 2) {
        return; // Let WASM renderer controls handle
      }

      // Extrude handle drag start
      if (e.button === 0 && this._extrudeMode && this._extrudeHandleInfo && this._renderer3d) {
        const hi = this._extrudeHandleInfo;
        const tipScr = this._renderer3d.worldToScreen(hi.tip.x, hi.tip.y, hi.tip.z);
        if (tipScr) {
          const hdx = sx - tipScr.x, hdy = sy - tipScr.y;
          if (hdx * hdx + hdy * hdy < 625) { // 25px radius
            this._draggingExtrudeHandle = true;
            const oScr = this._renderer3d.worldToScreen(hi.origin.x, hi.origin.y, hi.origin.z);
            const uPt = { x: hi.origin.x + hi.dir.x, y: hi.origin.y + hi.dir.y, z: hi.origin.z + hi.dir.z };
            const uScr = this._renderer3d.worldToScreen(uPt.x, uPt.y, uPt.z);
            if (oScr && uScr) {
              const adx = uScr.x - oScr.x, ady = uScr.y - oScr.y;
              const ppu = Math.sqrt(adx * adx + ady * ady);
              if (ppu > 0.01) {
                this._extrudeDragStart = { sx, sy, distance: this._extrudeMode.distance, axisX: adx / ppu, axisY: ady / ppu, pixelsPerUnit: ppu };
                this.canvas.style.cursor = 'grabbing';
                return;
              }
            }
          }
        }
      }

      if (e.button === 0 && this.activeTool.onMouseDown) {
        if (this._sketchingOnPlane) {
          let wx, wy;
          if (this.activeTool.freehand) {
            const raw = this._screenToSketchWorld(sx, sy);
            if (!raw) return;
            wx = raw.x; wy = raw.y;
          } else {
            const sketchVP = this._getSketchViewport();
            if (sketchVP) {
              const basePoint = this.activeTool._startX !== undefined && this.activeTool.step > 0
                ? { x: this.activeTool._startX, y: this.activeTool._startY }
                : null;
              const { world } = getSnappedPosition(
                sx, sy, sketchVP, basePoint,
                { ignoreGridSnap: !!e.ctrlKey }
              );
              if (!world) return;
              wx = world.x; wy = world.y;
            } else {
              const raw = this._screenToSketchWorld(sx, sy);
              if (!raw) return;
              wx = raw.x; wy = raw.y;
            }
          }
          this.activeTool.onMouseDown(wx, wy, sx, sy, e);
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

      // Extrude handle dragging
      if (this._draggingExtrudeHandle && this._extrudeDragStart && this._extrudeMode) {
        const ds = this._extrudeDragStart;
        const mdx = sx - ds.sx, mdy = sy - ds.sy;
        const proj = mdx * ds.axisX + mdy * ds.axisY;
        const rawDist = ds.distance + proj / ds.pixelsPerUnit;
        const newDist = Math.max(0.1, Math.round(rawDist * 10) / 10);
        if (newDist !== this._extrudeMode.distance) {
          this._extrudeMode.distance = newDist;
          const distInput = document.querySelector('#left-feature-params-content input[type="number"]');
          if (distInput) distInput.value = newDist;
          this._updateExtrudePreview();
        }
        return;
      }

      // Extrude handle hover cursor
      if (this._extrudeMode && this._extrudeHandleInfo && !mouseDown && this._renderer3d) {
        const hi = this._extrudeHandleInfo;
        const tipScr = this._renderer3d.worldToScreen(hi.tip.x, hi.tip.y, hi.tip.z);
        if (tipScr) {
          const hdx = sx - tipScr.x, hdy = sy - tipScr.y;
          const isNearHandle = hdx * hdx + hdy * hdy < 625;
          if (isNearHandle) {
            this.canvas.style.cursor = 'pointer';
            if (!this._extrudeArrowHoveredState) {
              this._extrudeArrowHoveredState = true;
              this._renderer3d.setExtrudeArrow(hi.origin, hi.tip, true);
              this._scheduleRender();
            }
            return;
          } else if (this._extrudeArrowHoveredState) {
            this._extrudeArrowHoveredState = false;
            this._renderer3d.setExtrudeArrow(hi.origin, hi.tip, false);
            this._scheduleRender();
          }
        }
      }

      if (this._sketchingOnPlane) {
        // Sketching on plane in 3D: process pointer for sketch tools
        this._lastPointer = { sx, sy, ctrlKey: e.ctrlKey };
        this._scheduleSketchPointerProcessing();
        this._scheduleRender();
        return;
      }

      // Scene manager active: suppress all part hover/pick interactions
      if (this._sceneManagerOpen) return;

      // Plane hover highlight in Part mode 3D view
      if (this._workspaceMode === 'part' && this._renderer3d) {
        // Disable hover highlighting while rotating/panning (mouseDown)
        if (mouseDown) {
          if (this._renderer3d._hoveredEdgeIndex >= 0) { this._renderer3d.setHoveredEdge(-1); this._scheduleRender(); }
          if (this._renderer3d._hoveredFaceIndex >= 0) { this._renderer3d.setHoveredFace(-1); this._scheduleRender(); }
          if (this._hoveredPlane) { this._hoveredPlane = null; this._renderer3d.setHoveredPlane(null); this._scheduleRender(); }
          this.canvas.style.cursor = '';
        } else if ((this._chamferMode || this._filletMode) && this._renderer3d._edgeSelectionMode) {
          // Edge/face hover for chamfer/fillet mode
          const edgeHit = this._renderer3d.pickEdge(e.clientX, e.clientY);
          if (edgeHit) {
            this._renderer3d.setHoveredEdge(edgeHit.edgeIndex);
            this._renderer3d.setHoveredFace(-1);
            this.canvas.style.cursor = 'pointer';
          } else {
            const faceHit = this._renderer3d.pickFace(e.clientX, e.clientY);
            if (faceHit) {
              this._renderer3d.setHoveredEdge(-1);
              this._renderer3d.setHoveredFace(faceHit.faceIndex);
              this.canvas.style.cursor = 'pointer';
            } else {
              this._renderer3d.setHoveredEdge(-1);
              this._renderer3d.setHoveredFace(-1);
              this.canvas.style.cursor = '';
            }
          }
          this._scheduleRender();
        } else if (!this._sketchingOnPlane && !this._extrudeMode) {
          // Default part mode: hover highlight for edges and faces
          const edgeHit = this._renderer3d.pickEdge(e.clientX, e.clientY);
          if (edgeHit) {
            this._renderer3d.setHoveredEdge(edgeHit.edgeIndex);
            this._renderer3d.setHoveredFace(-1);
            this.canvas.style.cursor = 'pointer';
            this._scheduleRender();
          } else {
            const faceHit = this._renderer3d.pickFace(e.clientX, e.clientY);
            if (faceHit) {
              this._renderer3d.setHoveredEdge(-1);
              this._renderer3d.setHoveredFace(faceHit.faceIndex);
              this.canvas.style.cursor = 'pointer';
              this._scheduleRender();
            } else {
              let changed = false;
              if (this._renderer3d._hoveredEdgeIndex >= 0) { this._renderer3d.setHoveredEdge(-1); changed = true; }
              if (this._renderer3d._hoveredFaceIndex >= 0) { this._renderer3d.setHoveredFace(-1); changed = true; }
              if (changed) { this.canvas.style.cursor = ''; this._scheduleRender(); }
            }
          }
        }

        if (!mouseDown) {
          const hitPlaneResult = this._renderer3d.pickPlane(e.clientX, e.clientY);
          const hitPlane = hitPlaneResult ? hitPlaneResult.name : null;
          if (hitPlane !== this._hoveredPlane) {
            this._hoveredPlane = hitPlane;
            this._renderer3d.setHoveredPlane(hitPlane);
            const planeItems = document.querySelectorAll('.node-tree-plane[data-plane]');
            planeItems.forEach(p => p.classList.toggle('hovered', p.getAttribute('data-plane') === hitPlane));
            if (!this._chamferMode && !this._filletMode) {
              this.canvas.style.cursor = hitPlane ? 'pointer' : '';
            }
          }
        }
      }

      this._scheduleRender();
    });

    // Mouse up
    canvas.addEventListener('mouseup', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      mouseDown = false;

      // Extrude handle drag end
      if (this._draggingExtrudeHandle) {
        this._draggingExtrudeHandle = false;
        this._extrudeDragStart = null;
        this.canvas.style.cursor = '';
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
      if (movedSinceDown && this.activeTool.name === 'select') {
        movedSinceDown = false;
        return;
      }
      
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      if (this._sketchingOnPlane) {
        if (this.activeTool.name === 'select' && this.activeTool._isDragging) return;
        // Sketching on plane in 3D: raycast to plane with snap support
        const sketchVP = this._getSketchViewport();
        let world;
        if (sketchVP) {
          const basePoint = this.activeTool._startX !== undefined && this.activeTool.step > 0
            ? { x: this.activeTool._startX, y: this.activeTool._startY }
            : null;
          const result = getSnappedPosition(
            sx, sy, sketchVP, basePoint,
            { ignoreGridSnap: !!e.ctrlKey }
          );
          world = result.world;
        } else {
          world = this._screenToSketchWorld(sx, sy);
        }
        if (world && this.activeTool.onClick) {
          // Record every click in model space for interaction replay
          this._recorder.clickAt(world.x, world.y);
          this.activeTool.onClick(world.x, world.y, e);
        }
        movedSinceDown = false;
        this._scheduleRender();
        return;
      }

      const world = this._renderer3d.screenToWorld(sx, sy);

      // In Part mode 3D view: handle sketch/face/geometry picking and plane clicking
      if (this._workspaceMode === 'part' && this._renderer3d) {
        // Scene manager active: suppress all part picking interactions
        if (this._sceneManagerOpen) return;
        // Edge/face picking for chamfer/fillet mode
        if ((this._chamferMode || this._filletMode) && this._renderer3d._edgeSelectionMode) {
          const edgeHit = this._renderer3d.pickEdge(e.clientX, e.clientY);
          if (edgeHit) {
            // Shift = always add, Ctrl = toggle, plain = clear + add
            if (e.shiftKey) {
              this._renderer3d.addEdgeSelection(edgeHit.edgeIndex);
            } else if (e.ctrlKey) {
              this._renderer3d.toggleEdgeSelection(edgeHit.edgeIndex);
            } else {
              this._renderer3d.clearEdgeSelection();
              this._selectedFacesForEdges = new Map();
              this._renderer3d.addEdgeSelection(edgeHit.edgeIndex);
            }
            this._onEdgeSelectionChanged();
            this._scheduleRender();
            this._updateNodeTree();
            this._updateOperationButtons();
            return;
          }
          // No edge hit — try face picking to select all edges around that face
          const faceHit = this._renderer3d.pickFace(e.clientX, e.clientY);
          if (faceHit) {
            const faceIdx = faceHit.faceIndex;
            const faceEdges = this._renderer3d.getEdgeIndicesForFace(faceIdx);
            if (!e.shiftKey && !e.ctrlKey) {
              this._renderer3d.clearEdgeSelection();
              this._selectedFacesForEdges = new Map();
            }
            if (e.ctrlKey) {
              // Toggle: if face is already tracked, remove it
              if (this._selectedFacesForEdges && this._selectedFacesForEdges.has(faceIdx)) {
                for (const i of faceEdges) this._renderer3d.removeEdgeSelection(i);
                this._selectedFacesForEdges.delete(faceIdx);
              } else {
                this._renderer3d.selectEdgesForFace(faceIdx);
                if (this._selectedFacesForEdges) this._selectedFacesForEdges.set(faceIdx, faceEdges);
              }
            } else {
              this._renderer3d.selectEdgesForFace(faceIdx);
              if (this._selectedFacesForEdges) this._selectedFacesForEdges.set(faceIdx, faceEdges);
            }
            this._onEdgeSelectionChanged();
            this._scheduleRender();
            this._updateNodeTree();
            this._updateOperationButtons();
            return;
          }
          // Clicked empty space — clear selection (unless modifier held)
          if (!e.shiftKey && !e.ctrlKey) {
            this._renderer3d.clearEdgeSelection();
            this._selectedFacesForEdges = new Map();
            this._onEdgeSelectionChanged();
            this._scheduleRender();
          }
          this._updateNodeTree();
          this._updateOperationButtons();
          return;
        }

        // Edge/face picking in default part select mode (multi-select with Shift/Ctrl)
        if (!this._sketchingOnPlane && !this._extrudeMode) {
          const edgeHit = this._renderer3d.pickEdge(e.clientX, e.clientY);
          if (edgeHit) {
            this._renderer3d.setHoveredEdge(-1);
            if (e.shiftKey) {
              this._renderer3d.addEdgeSelection(edgeHit.edgeIndex);
            } else if (e.ctrlKey) {
              this._renderer3d.toggleEdgeSelection(edgeHit.edgeIndex);
            } else {
              // Clear all other selections and select this edge
              this._selectedFaces.clear();
              this._selectedPlane = null;
              this._renderer3d.clearFaceSelection();
              this._renderer3d.setSelectedPlane(null);
              this._renderer3d.clearEdgeSelection();
              if (this._featurePanel) this._featurePanel.selectFeature(null);
              this._renderer3d.setSelectedFeature(null);
              if (this._parametersPanel) this._parametersPanel.clear();
              this._renderer3d.addEdgeSelection(edgeHit.edgeIndex);
            }
            const seg = edgeHit.edge;
            const prec = 2;
            const fmt = (v) => `(${v.x.toFixed(prec)}, ${v.y.toFixed(prec)}, ${v.z.toFixed(prec)})`;
            this.setStatus(`Edge: ${fmt(seg.start)} \u2192 ${fmt(seg.end)}`);
            this._onEdgeSelectionChanged();
            this._scheduleRender();
            this._updateNodeTree();
            this._updateOperationButtons();
            return;
          }
        }

        // Try sketch picking first (wireframes are visually on top)
        // When awaiting sketch plane selection, intercept face/plane clicks
        if (this._awaitingSketchPlane) {
          const faceHit = this._renderer3d.pickFace(e.clientX, e.clientY);
          if (faceHit && faceHit.face) {
            if (faceHit.face.isCurved) {
              this.setStatus('Cannot sketch on a curved surface. Select a flat face or reference plane.');
            } else {
              this._awaitingSketchPlane = false;
              const btn = document.getElementById('btn-sketch-on-plane');
              if (btn) btn.classList.remove('awaiting');
              this._startSketchOnFace(faceHit);
            }
            this._scheduleRender();
            return;
          }
          const planeHit = this._renderer3d.pickPlane(e.clientX, e.clientY);
          if (planeHit) {
            this._awaitingSketchPlane = false;
            const btn = document.getElementById('btn-sketch-on-plane');
            if (btn) btn.classList.remove('awaiting');
            this._startSketchOnPlane(planeHit.name);
            this._scheduleRender();
            return;
          }
          // Clicked empty space — keep waiting
          this._scheduleRender();
          return;
        }

        const sketchHit = this._renderer3d.pickSketch(e.clientX, e.clientY);
        if (sketchHit) {
          if (!e.shiftKey && !e.ctrlKey) {
            this._selectedFaces.clear();
            this._renderer3d.clearFaceSelection();
            this._selectedPlane = null;
            this._renderer3d.setSelectedPlane(null);
            this._renderer3d.clearEdgeSelection();
          }
          this._renderer3d.setSelectedFeature(sketchHit.featureId);

          const feature = this._partManager.getFeatures().find(f => f.id === sketchHit.featureId);
          if (feature) {
            if (this._featurePanel) this._featurePanel.selectFeature(feature.id);
            if (this._parametersPanel) this._parametersPanel.showFeature(feature);
            this._showLeftFeatureParams(feature);
            this._recorder.featureSelected(feature.id, feature.type, feature.name);
          }

          this.setStatus(`Selected sketch ${sketchHit.featureId}`);
          info(`Sketch selected: ${sketchHit.featureId}`);
        } else {
          const hit = this._renderer3d.pickFace(e.clientX, e.clientY);
          if (hit) {
            if (e.shiftKey) {
              // Shift+click: add face to selection
              this._selectedFaces.set(hit.faceIndex, hit);
              this._renderer3d.addFaceSelection(hit.faceIndex);
            } else if (e.ctrlKey) {
              // Ctrl+click: toggle face in selection
              if (this._selectedFaces.has(hit.faceIndex)) {
                this._selectedFaces.delete(hit.faceIndex);
                this._renderer3d.removeFaceSelection(hit.faceIndex);
              } else {
                this._selectedFaces.set(hit.faceIndex, hit);
                this._renderer3d.addFaceSelection(hit.faceIndex);
              }
            } else {
              // Single select: clear others
              this._selectedPlane = null;
              this._renderer3d.setSelectedPlane(null);
              this._renderer3d.clearEdgeSelection();
              if (this._featurePanel) this._featurePanel.selectFeature(null);
              this._renderer3d.setSelectedFeature(null);
              if (this._parametersPanel) this._parametersPanel.clear();
              this._selectedFaces.clear();
              this._selectedFaces.set(hit.faceIndex, hit);
              this._renderer3d.selectFace(hit.faceIndex);
            }
            this._showLeftFeatureParams(null);
            this.setStatus(`Selected face ${hit.faceIndex} (normal: ${hit.face.normal.x.toFixed(2)}, ${hit.face.normal.y.toFixed(2)}, ${hit.face.normal.z.toFixed(2)})`);
            info(`Face selected: ${hit.faceIndex}`);
            this._recorder.faceSelected(hit.faceIndex, hit.face.faceGroup, hit.face.normal, hit.face.shared && hit.face.shared.sourceFeatureId, hit.point);
          } else {
            // Try plane picking
            const hitPlaneResult = this._renderer3d.pickPlane(e.clientX, e.clientY);
            const clickPoint3D = hitPlaneResult ? hitPlaneResult.point : null;

            this._recorder.faceDeselected(clickPoint3D);

            if (hitPlaneResult) {
              if (e.ctrlKey && this._selectedPlane === hitPlaneResult.name) {
                this._selectedPlane = null;
              } else if (!e.shiftKey && !e.ctrlKey) {
                this._selectedFaces.clear();
                this._renderer3d.clearFaceSelection();
                this._renderer3d.clearEdgeSelection();
                if (this._featurePanel) this._featurePanel.selectFeature(null);
                this._renderer3d.setSelectedFeature(null);
                if (this._parametersPanel) this._parametersPanel.clear();
                this._selectedPlane = hitPlaneResult.name;
              } else {
                this._selectedPlane = hitPlaneResult.name;
              }
            } else if (!e.shiftKey && !e.ctrlKey) {
              // Clicked empty space: deselect all
              this._selectedFaces.clear();
              this._selectedPlane = null;
              this._renderer3d.clearFaceSelection();
              this._renderer3d.clearEdgeSelection();
              if (this._featurePanel) this._featurePanel.selectFeature(null);
              this._renderer3d.setSelectedFeature(null);
              if (this._parametersPanel) this._parametersPanel.clear();
            }
            this._renderer3d.setSelectedPlane(this._selectedPlane);
            if (this._selectedPlane && hitPlaneResult) {
              this._showLeftFeatureParams(null);
              this.setStatus(`Selected ${this._selectedPlane} plane`);
              info(`Plane selected in 3D: ${this._selectedPlane}`);
              this._recorder.planeSelected(this._selectedPlane, hitPlaneResult.point);
            } else {
              this._showLeftFeatureParams(null);
            }
          }
        }
        this._updateNodeTree();
        this._updateOperationButtons();
      }

      if (this.activeTool.onClick) {
        this.activeTool.onClick(world.x, world.y, e);
      }

      this._scheduleRender();
    });

    // Double click
    canvas.addEventListener('dblclick', (e) => {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;

      // In sketch-on-plane mode: support double-click editing of dimensions
      if (this._sketchingOnPlane) {
        const world = this._screenToSketchWorld(sx, sy);
        if (world) {
          const wpp = (this._renderer3d._orbitRadius || 100) / Math.max(rect.width, 1);
          const tol = 12 * wpp;
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
            return;
          }
        }
      }

      // In Part mode: double-click sketch wireframe to enter sketch edit mode
      if (this._workspaceMode === 'part' && !this._sketchingOnPlane && this._renderer3d) {
        const sketchHit = this._renderer3d.pickSketch(e.clientX, e.clientY);
        if (sketchHit) {
          const feature = this._partManager.getFeatures().find(f => f.id === sketchHit.featureId);
          if (feature && feature.type === 'sketch') {
            this._recorder.sketchEditStarted(feature.id, feature.name);
            this._editExistingSketch(feature);
            return;
          }
        }
      }

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
    // WasmRenderer handles orbit zoom via its own wheel handler
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this._scheduleRender();
    }, { passive: false });

    // Touch events for sketch-on-plane interaction
    canvas.addEventListener('touchstart', (e) => {
      if (!this._sketchingOnPlane) return;
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches[0];
      const sx = touch.clientX - rect.left;
      const sy = touch.clientY - rect.top;
      const sketchVP = this._getSketchViewport();
      let world;
      if (sketchVP) {
        const basePoint = this.activeTool._startX !== undefined && this.activeTool.step > 0
          ? { x: this.activeTool._startX, y: this.activeTool._startY }
          : null;
        const result = getSnappedPosition(sx, sy, sketchVP, basePoint);
        world = result.world;
      } else {
        world = this._screenToSketchWorld(sx, sy);
      }
      if (world && this.activeTool.onClick) {
        this.activeTool.onClick(world.x, world.y, e);
      }
      this._scheduleRender();
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (!this._sketchingOnPlane) return;
      if (e.touches.length !== 1) return;
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const touch = e.touches[0];
      const sx = touch.clientX - rect.left;
      const sy = touch.clientY - rect.top;
      const sketchVP = this._getSketchViewport();
      let world, snap;
      if (sketchVP) {
        const basePoint = this.activeTool._startX !== undefined && this.activeTool.step > 0
          ? { x: this.activeTool._startX, y: this.activeTool._startY }
          : null;
        const result = getSnappedPosition(sx, sy, sketchVP, basePoint);
        world = result.world;
        snap = result.snap;
      } else {
        world = this._screenToSketchWorld(sx, sy);
        snap = null;
      }
      if (world) {
        this.renderer.cursorWorld = world;
        this.renderer.snapPoint = snap;
        this.activeTool.onMouseMove(world.x, world.y, sx, sy);
        this._scheduleRender();
      }
    }, { passive: false });
  }

  // --- Toolbar ---
  _bindMenuBarEvents() {
    const menuBar = document.getElementById('menu-bar');
    if (!menuBar) return;
    let openMenu = null;

    // Toggle menu on click
    menuBar.querySelectorAll('.menu-item').forEach(item => {
      const label = item.querySelector('.menu-label');
      label.addEventListener('click', (e) => {
        e.stopPropagation();
        if (openMenu === item) {
          item.classList.remove('open');
          openMenu = null;
        } else {
          if (openMenu) openMenu.classList.remove('open');
          item.classList.add('open');
          openMenu = item;
        }
      });
      // Hover to switch between open menus
      item.addEventListener('mouseenter', () => {
        if (openMenu && openMenu !== item) {
          openMenu.classList.remove('open');
          item.classList.add('open');
          openMenu = item;
        }
      });
    });

    // Close on outside click
    document.addEventListener('click', () => {
      if (openMenu) { openMenu.classList.remove('open'); openMenu = null; }
    });

    // Handle menu actions
    menuBar.querySelectorAll('.menu-dropdown button').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (openMenu) { openMenu.classList.remove('open'); openMenu = null; }
        const action = btn.dataset.action;
        switch (action) {
          case 'new': document.getElementById('btn-new')?.click(); break;
          case 'open': document.getElementById('btn-open')?.click(); break;
          case 'save': document.getElementById('btn-save')?.click(); break;
          case 'open-cmod': this._openCMODProject?.(); break;
          case 'save-cmod': downloadCMOD?.(); break;
          case 'import-json': document.getElementById('btn-open')?.click(); break;
          case 'export-json': document.getElementById('btn-save')?.click(); break;
          case 'import-dxf': this._importDXFToSketch(); break;
          case 'export-dxf': this._exportDXFFromFaces(); break;
          // Dynamic examples are handled via event delegation below
          case 'toggle-grid': document.getElementById('btn-grid-toggle')?.click(); break;
          case 'toggle-snap': document.getElementById('btn-snap-toggle')?.click(); break;
          case 'toggle-ortho': document.getElementById('btn-ortho-toggle')?.click(); break;
          case 'toggle-autoconnect': document.getElementById('btn-autocoincidence-toggle')?.click(); break;
          case 'tool-select': this.setActiveTool('select'); break;
          case 'tool-line': this.setActiveTool('line'); break;
          case 'tool-rect': this.setActiveTool('rectangle'); break;
          case 'tool-circle': this.setActiveTool('circle'); break;
          case 'tool-arc': this.setActiveTool('arc'); break;
          case 'tool-chamfer': document.getElementById('btn-chamfer')?.click(); break;
          case 'tool-fillet': document.getElementById('btn-fillet')?.click(); break;
          case 'toggle-diagnostic-hatch': this._toggleDiagnosticBackfaceHatchPref(); break;
          case 'scene-manager': this._toggleSceneManager(); break;
          case 'toggle-recording-bar': this._toggleRecordingBar(); break;
          case 'toggle-command-bar': this._toggleCommandBar(); break;
          case 'help-shortcuts': this.setStatus('Shortcuts: L=Line, R=Rect, C=Circle, Esc=Select, Del=Delete, Ctrl+Z=Undo, Ctrl+Y=Redo, F=Fit'); break;
          case 'help-about': this.setStatus('CAD Modeller v1.0.0 — Parametric 2D/3D CAD'); break;
        }
      });
    });

    // Dynamic examples submenu — event delegation + population
    const examplesSubmenu = document.getElementById('examples-submenu');
    if (examplesSubmenu) {
      examplesSubmenu.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-file]');
        if (!btn) return;
        e.stopPropagation();
        if (openMenu) { openMenu.classList.remove('open'); openMenu = null; }
        this._loadExample(btn.dataset.file);
      });
      this._populateExamplesMenu(examplesSubmenu);
    }
  }

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
        this._createNewDrawing();
      }
    });
    document.getElementById('btn-save').addEventListener('click', () => {
      if (this._workspaceMode === 'part') {
        downloadCMOD();
      } else {
        downloadDXF();
      }
    });
    document.getElementById('btn-open').addEventListener('click', () => {
      if (this._workspaceMode === 'part') {
        this._openCMODProject();
      } else {
        info('Opening DXF file');
        openDXFFile();
        setTimeout(() => {
          this.viewport.fitEntities(state.entities);
          this._scheduleRender();
        }, 500);
      }
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
      this._recorder.settingToggled('grid', state.gridVisible);
      this._scheduleRender();
    });

    // Snap
    document.getElementById('btn-snap-toggle').addEventListener('click', (e) => {
      state.snapEnabled = !state.snapEnabled;
      this._recorder.settingToggled('snap', state.snapEnabled);
      e.currentTarget.classList.toggle('active', state.snapEnabled);
      document.getElementById('status-snap').classList.toggle('active', state.snapEnabled);
    });
    // Auto-connect coincidences
    document.getElementById('btn-autocoincidence-toggle').addEventListener('click', (e) => {
      state.autoCoincidence = !state.autoCoincidence;
      this._recorder.settingToggled('autoCoincidence', state.autoCoincidence);
      e.currentTarget.classList.toggle('active', state.autoCoincidence);
      document.getElementById('status-autocoincidence').classList.toggle('active', state.autoCoincidence);
    });
    document.getElementById('btn-ortho-toggle').addEventListener('click', (e) => {
      state.orthoEnabled = !state.orthoEnabled;
      this._recorder.settingToggled('ortho', state.orthoEnabled);
      e.currentTarget.classList.toggle('active', state.orthoEnabled);
      document.getElementById('status-ortho').classList.toggle('active', state.orthoEnabled);
      if (this._renderer3d) {
        this._renderer3d.setOrtho3D(state.orthoEnabled);
      }
      this._scheduleRender();
    });

    // FOV slider — raw 0 = ortho, raw 1..116 maps to 5..120°
    const fovSlider = document.getElementById('fov-slider');
    const fovValue = document.getElementById('fov-value');
    if (fovSlider) {
      fovSlider.addEventListener('input', () => {
        const raw = parseInt(fovSlider.value, 10);
        const deg = raw === 0 ? 0 : raw + 4; // 0→0, 1→5, 2→6 … 116→120
        if (fovValue) fovValue.textContent = deg === 0 ? 'Ortho' : deg + '\u00b0';
        if (this._renderer3d) {
          this._renderer3d.setFOV(deg);
          this._recorder.fovChanged(deg);
        }
        this._scheduleRender();
      });
    }

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
      // Don't intercept when a modal dialog is open
      if (isModalOpen()) return;

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
          case 's':
            e.preventDefault();
            if (this._workspaceMode === 'part') downloadCMOD();
            else downloadDXF();
            break;
          case 'n':
            e.preventDefault();
            showConfirm({ title: 'New Drawing', message: 'Clear all?', okText: 'Clear', cancelText: 'Cancel' })
              .then((ok) => {
                if (ok) {
                  this._createNewDrawing();
                }
              });
            break;
          case 'd': e.preventDefault(); this.setActiveTool('copy'); break;
          case '8': e.preventDefault(); this._orientToNormalView(); break;
          case 'a':
            e.preventDefault();
            state.entities.forEach(ent => state.select(ent));
            this._scheduleRender();
            break;
        }
        return;
      }

      switch (e.key) {
        case 'Escape': {
          // Cancel awaiting sketch plane selection first
          if (this._awaitingSketchPlane) {
            this._cancelAwaitSketchPlane();
            break;
          }

          // Check if anything is currently selected
          const hadSelection =
            !!this._selectedPlane ||
            this._selectedFaces.size > 0 ||
            (this._featurePanel && !!this._featurePanel.selectedFeatureId) ||
            (this._renderer3d && this._renderer3d._selectedFeatureId) ||
            state.selectedEntities.length > 0;

          const hadActiveTool = this.activeTool && this.activeTool.name !== 'select';

          if (hadSelection) {
            // First ESC: deselect all selections
            if (this._selectedPlane) {
              this._selectedPlane = null;
              if (this._renderer3d) this._renderer3d.setSelectedPlane(null);
            }
            if (this._selectedFaces.size > 0) {
              this._selectedFaces.clear();
              if (this._renderer3d) this._renderer3d.clearFaceSelection();
            }
            if (this._featurePanel && this._featurePanel.selectedFeatureId) {
              this._featurePanel.selectFeature(null);
            }
            if (this._renderer3d) {
              this._renderer3d.setSelectedFeature(null);
            }
            if (this._parametersPanel) this._parametersPanel.clear();
            this._showLeftFeatureParams(null);
            state.clearSelection();
            this._updateNodeTree();
            this._update3DView();
            this._scheduleRender();
          } else if (hadActiveTool) {
            // Cancel active tool (e.g. line drawing) and switch to select
            this.activeTool.onCancel();
            this.setActiveTool('select');
            this._scheduleRender();
          } else if (this._extrudeMode) {
            // In extrude mode — trigger exit extrude
            document.getElementById('btn-exit-extrude').click();
          } else if (this._sketchingOnPlane) {
            // Nothing selected, no active tool — trigger exit sketch
            document.getElementById('btn-exit-sketch').click();
          } else {
            // Fallback: clear anything residual
            state.clearSelection();
            this._updateNodeTree();
            this._update3DView();
            this._scheduleRender();
          }
          break;
        }
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
        case 'x': case 'X':
          if (this._awaitingSketchPlane) { this._cancelAwaitSketchPlane(); break; }
          this.setActiveTool('trim');
          break;
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
        case '0':
          this._orientToNormalView();
          break;
        case 'Home':
          if (this._workspaceMode === 'part' && this._renderer3d) {
            this._renderer3d.homeCamera();
            this._scheduleRender();
          }
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
    // Lowercase first token for matching; preserve case in arguments for replay fidelity
    const raw = cmd.trim().split(/\s+/);
    const command = raw[0].toLowerCase();
    const args = raw.slice(1);

    // ---- Dotted navigation / interaction commands (from recorder) ----

    if (command === 'camera.set') {
      // camera.set <theta> <phi> <radius> <tx> <ty> <tz>
      if (args.length >= 6 && this._renderer3d) {
        this._renderer3d.setOrbitState({
          theta: parseFloat(args[0]),
          phi: parseFloat(args[1]),
          radius: parseFloat(args[2]),
          target: { x: parseFloat(args[3]), y: parseFloat(args[4]), z: parseFloat(args[5]) },
        });
        this._scheduleRender();
      }
      return;
    }

    if (command === 'camera.home') {
      if (this._renderer3d) {
        this._renderer3d.homeCamera();
        this._scheduleRender();
      }
      return;
    }

    if (command === 'workspace') {
      // workspace part
      if (args[0]) this._enterWorkspace(args[0]);
      return;
    }

    if (command === 'tool') {
      // tool <name>
      if (args[0]) this.setActiveTool(args[0]);
      return;
    }

    if (command === 'select.face') {
      // select.face <faceIndex> [faceGroup] [nx ny nz] [sourceFeatureId]
      if (args.length >= 1 && this._renderer3d) {
        const faceIndex = parseInt(args[0], 10);
        const faceMeta = this._renderer3d.getFaceInfo(faceIndex);
        if (faceMeta) {
          this._selectedFaces.clear();
          this._selectedFaces.set(faceIndex, { faceIndex, face: faceMeta });
          this._renderer3d.selectFace(faceIndex);
          this._selectedPlane = null;
          this._renderer3d.setSelectedPlane(null);
        }
        this._updateNodeTree();
        this._updateOperationButtons();
      }
      return;
    }

    if (command === 'deselect.face') {
      this._selectedFaces.clear();
      if (this._renderer3d) this._renderer3d.clearFaceSelection();
      this._updateNodeTree();
      this._updateOperationButtons();
      return;
    }

    if (command === 'select.plane') {
      // select.plane XY|XZ|YZ
      if (args[0]) {
        this._selectedPlane = args[0].toUpperCase();
        if (this._renderer3d) this._renderer3d.setSelectedPlane(this._selectedPlane);
        this._selectedFaces.clear();
        if (this._renderer3d) this._renderer3d.clearFaceSelection();
        this._updateNodeTree();
        this._updateOperationButtons();
      }
      return;
    }

    if (command === 'select.feature') {
      // select.feature <featureId>
      if (args[0]) {
        const featureId = args[0];
        if (this._featurePanel) this._featurePanel.selectFeature(featureId);
        if (this._renderer3d) this._renderer3d.setSelectedFeature(featureId);
        this._updateNodeTree();
        this._update3DView();
        this._scheduleRender();
      }
      return;
    }

    if (command === 'sketch.start') {
      // sketch.start XY|XZ|YZ  OR  sketch.start FACE ox oy oz nx ny nz xax xay xaz yax yay yaz
      if (args[0] && args[0].toUpperCase() === 'FACE' && args.length >= 13) {
        const planeDef = {
          origin: { x: parseFloat(args[1]), y: parseFloat(args[2]), z: parseFloat(args[3]) },
          normal: { x: parseFloat(args[4]), y: parseFloat(args[5]), z: parseFloat(args[6]) },
          xAxis: { x: parseFloat(args[7]), y: parseFloat(args[8]), z: parseFloat(args[9]) },
          yAxis: { x: parseFloat(args[10]), y: parseFloat(args[11]), z: parseFloat(args[12]) },
        };
        this._startSketchOnFaceWithPlane(planeDef);
      } else if (args[0]) {
        this._startSketchOnPlane(args[0].toUpperCase());
      }
      return;
    }

    if (command === 'sketch.finish') {
      this._finishSketchOnPlane();
      return;
    }

    if (command === 'sketch.edit') {
      // sketch.edit <featureId>
      if (args[0]) {
        const part = this._partManager.getPart();
        if (part) {
          const feature = part.getFeature(args[0]);
          if (feature && feature.type === 'sketch') {
            this._editExistingSketch(feature);
          }
        }
      }
      return;
    }

    if (command === 'sketch.from-face') {
      // sketch.from-face <faceIndex> — handled by extrude auto-creation flow
      return;
    }

    if (command === 'feature.modify') {
      // feature.modify <featureId> <paramName> <value>
      if (args.length >= 3) {
        const featureId = args[0];
        const paramName = args[1];
        const value = args[2];
        this._applyFeatureModification(featureId, paramName, value);
      }
      return;
    }

    if (command === 'extrude') {
      // extrude <distance> [cut]
      if (args.length >= 1) {
        const dist = parseFloat(args[0]);
        const isCut = args[1] === 'cut';
        this._executeExtrude(dist, isCut);
      }
      return;
    }

    if (command === 'revolve') {
      // revolve <angleDeg>
      if (args.length >= 1) {
        const angle = parseFloat(args[0]);
        this._executeRevolve(angle);
      }
      return;
    }

    if (command === 'chamfer') {
      // chamfer <distance> <edgeKey1> [edgeKey2] ...
      if (args.length >= 2) {
        const distance = parseFloat(args[0]);
        const edgeKeys = args.slice(1);
        try {
          this._partManager.chamfer(edgeKeys, distance);
          this._deselectAll();
          if (this._featurePanel) this._featurePanel.update();
          this._updateNodeTree();
          this._update3DView();
          this._updateOperationButtons();
          this._scheduleRender();
        } catch (err) {
          this.setStatus(`Chamfer failed: ${err.message}`);
        }
      }
      return;
    }

    if (command === 'fillet') {
      // fillet <radius> <segments> <edgeKey1> [edgeKey2] ...
      if (args.length >= 3) {
        const radius = parseFloat(args[0]);
        const segments = parseInt(args[1], 10);
        const edgeKeys = args.slice(2);
        try {
          this._partManager.fillet(edgeKeys, radius, { segments });
          this._deselectAll();
          if (this._featurePanel) this._featurePanel.update();
          this._updateNodeTree();
          this._update3DView();
          this._updateOperationButtons();
          this._scheduleRender();
        } catch (err) {
          this.setStatus(`Fillet failed: ${err.message}`);
        }
      }
      return;
    }

    if (command === 'select.edge') {
      // select.edge <edgeKey> — handled during edge selection mode
      return;
    }

    if (command === 'deselect.edge') {
      // deselect.edge <edgeKey> — handled during edge selection mode
      return;
    }

    if (command === 'draw.line') {
      // draw.line <x1> <y1> <x2> <y2>
      // merge: true enables auto-coincidence so shared endpoints form proper constraints
      if (args.length >= 4) {
        state.scene.addSegment(
          parseFloat(args[0]), parseFloat(args[1]),
          parseFloat(args[2]), parseFloat(args[3]),
          { merge: true }
        );
        state.emit('change');
        this._scheduleRender();
      }
      return;
    }

    if (command === 'draw.rect') {
      // draw.rect <x1> <y1> <x2> <y2>
      if (args.length >= 4) {
        const x1 = parseFloat(args[0]), y1 = parseFloat(args[1]);
        const x2 = parseFloat(args[2]), y2 = parseFloat(args[3]);
        state.scene.addSegment(x1, y1, x2, y1, { merge: true });
        state.scene.addSegment(x2, y1, x2, y2, { merge: true });
        state.scene.addSegment(x2, y2, x1, y2, { merge: true });
        state.scene.addSegment(x1, y2, x1, y1, { merge: true });
        state.emit('change');
        this._scheduleRender();
      }
      return;
    }

    if (command === 'draw.circle') {
      // draw.circle <cx> <cy> <radius>
      if (args.length >= 3) {
        state.scene.addCircle(parseFloat(args[0]), parseFloat(args[1]), parseFloat(args[2]),
          { merge: true });
        state.emit('change');
        this._scheduleRender();
      }
      return;
    }

    if (command === 'draw.arc') {
      // draw.arc <cx> <cy> <radius> <startAngle> <endAngle>
      if (args.length >= 5) {
        state.scene.addArc(
          parseFloat(args[0]), parseFloat(args[1]), parseFloat(args[2]),
          parseFloat(args[3]), parseFloat(args[4]),
          { merge: true }
        );
        state.emit('change');
        this._scheduleRender();
      }
      return;
    }

    if (command === 'click') {
      // click <x> <y> — simulate a tool click at world coordinates
      if (args.length >= 2 && this.activeTool && this.activeTool.onClick) {
        const x = parseFloat(args[0]), y = parseFloat(args[1]);
        this.activeTool.onClick(x, y, {});
        this._scheduleRender();
      }
      return;
    }

    if (command === 'setting') {
      // setting <name> <value>
      if (args[0] === 'grid') { state.gridVisible = args[1] !== 'false'; }
      else if (args[0] === 'snap') { state.snapEnabled = args[1] !== 'false'; }
      else if (args[0] === 'ortho') { state.orthoEnabled = args[1] !== 'false'; }
      else if (args[0] === 'fov' && args[1] != null) {
        const deg = parseFloat(args[1]);
        if (this._renderer3d && isFinite(deg)) {
          this._renderer3d.setFOV(deg);
          this._syncFovSlider(deg);
        }
      }
      else if (args[0] === 'gridSize' && args[1] != null) {
        const size = parseFloat(args[1]);
        if (size > 0) state.gridSize = size;
      }
      else if (args[0] === 'construction') { state.constructionMode = args[1] !== 'false'; }
      else if (args[0] === 'autoCoincidence') { state.autoCoincidence = args[1] !== 'false'; }
      this._scheduleRender();
      return;
    }

    if (command === 'record.start') { this._startRecording(); return; }
    if (command === 'record.stop') { this._stopRecording(); return; }
    if (command === 'record.export') { this._exportRecording(); return; }
    if (command === 'record.play') {
      const speed = args[0] ? parseInt(args[0], 10) : 300;
      this._playbackRecording(speed);
      return;
    }

    // ---- Legacy tool / action commands (case-insensitive) ----

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
        if (args[0]) {
          const size = parseFloat(args[0]);
          if (size > 0) state.gridSize = size;
        } else {
          state.gridVisible = !state.gridVisible;
        }
        this._scheduleRender();
        break;
      case 'save':
        if (this._workspaceMode === 'part') downloadCMOD();
        else downloadDXF();
        break;
      case 'open':
        if (this._workspaceMode === 'part') this._openCMODProject();
        else openDXFFile();
        break;
      case 'new':
        showConfirm({ title: 'New Drawing', message: 'Clear all?', okText: 'Clear', cancelText: 'Cancel' })
          .then((ok) => {
            if (ok) {
              this._createNewDrawing();
            }
          });
        break;
      default:
        this.setStatus(`Unknown command: ${command}`);
    }
  }

  // --- Extrude/Revolve helpers for command execution (no prompts) ---

  _executeExtrude(distance, isCut = false) {
    if (!this._lastSketchFeatureId) return;
    const absDistance = Math.abs(distance);
    if (absDistance === 0) return;
    const extrudeOptions = isCut ? { operation: 'subtract', direction: -1 } : {};
    const feature = this._partManager.extrude(this._lastSketchFeatureId, absDistance, extrudeOptions);
    this._deselectAll();
    if (this._featurePanel) this._featurePanel.update();
    this._updateNodeTree();
    this._update3DView();
    this._updateOperationButtons();
    this._scheduleRender();
  }

  _executeRevolve(angleDeg) {
    if (!this._lastSketchFeatureId) return;
    const radians = (angleDeg * Math.PI) / 180;
    const feature = this._partManager.revolve(this._lastSketchFeatureId, radians);
    this._deselectAll();
    if (this._featurePanel) this._featurePanel.update();
    this._updateNodeTree();
    this._update3DView();
    this._updateOperationButtons();
    this._scheduleRender();
  }

  /**
   * Apply a parameter modification to an existing feature (used by command replay
   * and sidebar editing).
   * @param {string} featureId - Feature to modify
   * @param {string} paramName - Parameter name (distance, direction, operation, symmetric, angle, segments)
   * @param {string} value - New value (as string, will be parsed)
   */
  _applyFeatureModification(featureId, paramName, value) {
    const part = this._partManager.getPart();
    if (!part) return;
    const feature = part.getFeature(featureId);
    if (!feature) return;

    this._partManager.modifyFeature(featureId, (f) => {
      switch (paramName) {
        case 'distance':
          f.setDistance(parseFloat(value));
          break;
        case 'direction':
          f.direction = parseInt(value, 10);
          break;
        case 'operation':
          f.operation = value;
          break;
        case 'symmetric':
          f.symmetric = value === 'true' || value === true;
          break;
        case 'angle':
          if (typeof f.setAngle === 'function') f.setAngle(parseFloat(value));
          break;
        case 'segments':
          f.segments = parseInt(value, 10);
          break;
        default:
          break;
      }
    });

    if (this._featurePanel) this._featurePanel.update();
    this._updateNodeTree();
    this._update3DView();
    this._updateOperationButtons();
    this._scheduleRender();
  }

  /** Start sketch on face using an explicit plane definition (for command replay). */
  _startSketchOnFaceWithPlane(planeDef) {
    if (this._workspaceMode !== 'part') return;

    state.scene.clear();
    state.selectedEntities = [];
    this._sketchingOnPlane = true;
    this._activeSketchPlane = 'FACE';
    this._activeSketchPlaneDef = planeDef;
    this._3dMode = true;

    document.body.classList.add('sketch-on-plane');
    const exitBtn = document.getElementById('btn-exit-sketch');
    if (exitBtn) exitBtn.style.display = 'flex';

    if (this._renderer3d) {
      this._savedOrbitState = this._renderer3d.saveOrbitState();
      this._renderer3d.orientToPlaneNormal(planeDef.normal, planeDef.origin);
      // Lock to orthographic for sketch precision
      this._renderer3d.setFOV(0);
      this._syncFovSlider(0);
      this._renderer3d.setMode('3d');
      this._renderer3d.setVisible(true);
      this._renderer3d._sketchPlane = 'FACE';
      this._renderer3d._sketchPlaneDef = planeDef;
    }

    this._selectedPlane = null;
    if (this._renderer3d) this._renderer3d.setSelectedPlane(null);

    const modeIndicator = document.getElementById('status-mode');
    modeIndicator.textContent = 'SKETCH ON FACE';
    modeIndicator.className = 'status-mode sketch-mode';
    this.setActiveTool('select');
    this.setStatus('Sketching on face plane. Draw your profile, then Exit Sketch.');
    info('Entered sketch-on-face mode (command)');
    this._scheduleRender();
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

  /**
   * Show feature properties in the left panel (Part mode)
   * @param {Feature|null} feature
   */
  _showLeftFeatureParams(feature, options = {}) {
    const container = document.getElementById('left-feature-params-content');
    if (!container) return;
    const headerEl = document.querySelector('#left-feature-params > h3');
    const { enterEditMode = false } = options;
    // Don't overwrite UI when in extrude/chamfer/fillet mode
    if (this._extrudeMode || this._chamferMode || this._filletMode) return;
    // When DXF export panel is active, refresh it instead of overwriting
    if (this._dxfExportPanel && !feature) {
      this._dxfExportPanel.refresh();
      return;
    }
    if (!feature) {
      if (headerEl) headerEl.innerHTML = 'Feature Properties';
      this._showSelectionSummary(container);
      return;
    }
    // Update header with feature icon
    if (headerEl) {
      headerEl.innerHTML = `<span class="parameters-header-icon">${getFeatureIconSVG(feature.type)}</span>Feature Properties`;
    }
    container.innerHTML = '';

    // Name
    const nameRow = this._createParamRow('Name', 'text', feature.name, (v) => {
      feature.name = v;
      this._partManager.notifyListeners();
    });
    container.appendChild(nameRow);

    // Type badge
    const typeRow = document.createElement('div');
    typeRow.className = 'parameter-row';
    typeRow.innerHTML = `<label class="parameter-label">Type</label><span class="parameter-value">${feature.type}</span>`;
    container.appendChild(typeRow);

    if (feature.type === 'extrude' || feature.type === 'extrude-cut') {
      if (enterEditMode) {
        this._editExtrude(feature);
        return;
      }

      const sketchFeature = this._partManager.getFeatures().find((candidate) => candidate.id === feature.sketchFeatureId);
      const details = document.createElement('div');
      details.className = 'parameter-info';
      details.innerHTML = `
        <p><strong>Sketch:</strong> ${sketchFeature ? sketchFeature.name : 'None'}</p>
        <p><strong>Distance:</strong> ${feature.distance}</p>
        <p><strong>Direction:</strong> ${feature.direction >= 0 ? 'Normal' : 'Reverse'}</p>
        <p><strong>Operation:</strong> ${feature.operation || (feature.type === 'extrude-cut' ? 'subtract' : 'new')}</p>
        <p><strong>Symmetric:</strong> ${feature.symmetric ? 'Yes' : 'No'}</p>
      `;
      container.appendChild(details);

      const editBtn = document.createElement('button');
      editBtn.textContent = feature.type === 'extrude-cut' ? 'Edit Extrude Cut' : 'Edit Extrude';
      editBtn.style.cssText = 'width:100%;padding:8px;margin-top:8px;background:#2196f3;color:#fff;border:none;border-radius:4px;cursor:pointer';
      editBtn.addEventListener('click', () => this._editExtrude(feature));
      container.appendChild(editBtn);
    } else if (feature.type === 'revolve') {
      const angleDeg = (feature.angle * 180 / Math.PI).toFixed(1);
      container.appendChild(this._createParamRow('Angle (°)', 'number', angleDeg, (v) => {
        const rad = parseFloat(v) * Math.PI / 180;
        this._partManager.modifyFeature(feature.id, (f) => f.setAngle(rad));
        if (this._parametersPanel && this._parametersPanel.onParameterChange) this._parametersPanel.onParameterChange(feature.id, 'angle', rad);
      }));
      container.appendChild(this._createParamRow('Segments', 'number', feature.segments, (v) => {
        const parsed = parseInt(v);
        this._partManager.modifyFeature(feature.id, (f) => { f.segments = parsed; });
        if (this._parametersPanel && this._parametersPanel.onParameterChange) this._parametersPanel.onParameterChange(feature.id, 'segments', parsed);
      }));
    } else if (feature.type === 'sketch') {
      const info = document.createElement('div');
      info.className = 'parameter-info';
      info.innerHTML = `
        <p><strong>Segments:</strong> ${feature.sketch ? feature.sketch.segments.length : 0}</p>
        <p><strong>Points:</strong> ${feature.sketch ? feature.sketch.points.length : 0}</p>
      `;
      container.appendChild(info);
    } else if (feature.type === 'chamfer') {
      container.appendChild(this._createParamRow('Distance', 'number', feature.distance, (v) => {
        const parsed = parseFloat(v);
        if (!isNaN(parsed) && parsed > 0) {
          this._partManager.modifyFeature(feature.id, (f) => { f.distance = parsed; });
          this._update3DView();
        }
      }));
      const edgeRow = document.createElement('div');
      edgeRow.className = 'parameter-row';
      edgeRow.innerHTML = `<label class="parameter-label">Edges</label><span class="parameter-value">${feature.edgeKeys.length}</span>`;
      container.appendChild(edgeRow);
      // Edit Edges button
      const editEdgeBtn = document.createElement('button');
      editEdgeBtn.textContent = 'Edit Edges';
      editEdgeBtn.style.cssText = 'width:100%;padding:6px;margin-top:8px;background:#2196f3;color:#fff;border:none;border-radius:4px;cursor:pointer';
      editEdgeBtn.addEventListener('click', () => this._editChamferEdges(feature));
      container.appendChild(editEdgeBtn);
    } else if (feature.type === 'fillet') {
      container.appendChild(this._createParamRow('Radius', 'number', feature.radius, (v) => {
        const parsed = parseFloat(v);
        if (!isNaN(parsed) && parsed > 0) {
          this._partManager.modifyFeature(feature.id, (f) => { f.radius = parsed; });
          this._update3DView();
        }
      }));
      container.appendChild(this._createParamRow('Segments', 'number', feature.segments, (v) => {
        const parsed = parseInt(v, 10);
        if (!isNaN(parsed) && parsed >= 2) {
          this._partManager.modifyFeature(feature.id, (f) => { f.segments = parsed; });
          this._update3DView();
        }
      }));
      const edgeRow = document.createElement('div');
      edgeRow.className = 'parameter-row';
      edgeRow.innerHTML = `<label class="parameter-label">Edges</label><span class="parameter-value">${feature.edgeKeys.length}</span>`;
      container.appendChild(edgeRow);
      // Edit Edges button
      const editEdgeBtn = document.createElement('button');
      editEdgeBtn.textContent = 'Edit Edges';
      editEdgeBtn.style.cssText = 'width:100%;padding:6px;margin-top:8px;background:#2196f3;color:#fff;border:none;border-radius:4px;cursor:pointer';
      editEdgeBtn.addEventListener('click', () => this._editFilletEdges(feature));
      container.appendChild(editEdgeBtn);
    }

    // Feature steps (children)
    if (feature.children && feature.children.length > 0) {
      const stepsHeader = document.createElement('div');
      stepsHeader.className = 'parameter-row';
      stepsHeader.innerHTML = '<label class="parameter-label" style="font-weight:600;margin-top:8px">Steps</label>';
      container.appendChild(stepsHeader);
      const allFeatures = this._partManager.getFeatures();
      feature.children.forEach((childId) => {
        const child = allFeatures.find(f => f.id === childId);
        if (child) {
          const stepRow = document.createElement('div');
          stepRow.className = 'parameter-row lp-item';
          stepRow.style.cursor = 'pointer';
          stepRow.innerHTML = `<span class="node-tree-icon" style="opacity:0.6;margin-right:4px;display:inline-flex">${getFeatureIconSVG(child.type)}</span> ${child.name}`;
          stepRow.addEventListener('click', () => {
            if (this._featurePanel) this._featurePanel.selectFeature(child.id);
            this._showLeftFeatureParams(child);
            if (this._parametersPanel) this._parametersPanel.showFeature(child);
            this._updateNodeTree();
          });
          container.appendChild(stepRow);
        }
      });
    }
  }

  /**
   * Show the selection summary in the left panel when no feature is selected.
   */
  _showSelectionSummary(container) {
    container.innerHTML = '';

    // Hint text
    const hint = document.createElement('div');
    hint.className = 'hint edge-selection-hint';
    hint.textContent = 'Click to select faces, planes, or features. Shift+click to add, Ctrl+click to toggle.';
    container.appendChild(hint);

    // Unified selection list
    container.appendChild(this._buildSelectionList());
  }

  /**
   * Create a parameter row element for the left panel
   */
  _createParamRow(label, type, value, onChange, options) {
    const div = document.createElement('div');
    div.className = 'parameter-row';
    const lbl = document.createElement('label');
    lbl.className = 'parameter-label';
    lbl.textContent = label;
    div.appendChild(lbl);

    let input;
    if (type === 'checkbox') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value;
      input.addEventListener('change', (e) => onChange(e.target.checked));
    } else if (type === 'select') {
      input = document.createElement('select');
      input.className = 'parameter-input';
      for (const opt of options) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (String(opt.value) === String(value)) o.selected = true;
        input.appendChild(o);
      }
      input.addEventListener('change', (e) => onChange(e.target.value));
    } else {
      input = document.createElement('input');
      input.type = type;
      input.className = 'parameter-input';
      input.value = value;
      if (type === 'number') input.step = 'any';
      input.addEventListener('change', (e) => onChange(e.target.value));
    }
    div.appendChild(input);
    return div;
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
    this._featurePanel.isLocked = () => this._isEditingFeature();
    this._parametersPanel = new ParametersPanel(parametersPanelContainer, this._partManager);

    // Record sidebar parameter edits
    this._parametersPanel.setOnParameterChange((featureId, paramName, value) => {
      this._recorder.featureModified(featureId, paramName, value);
    });

    // Setup callbacks
    this._featurePanel.setOnFeatureSelect((feature) => {
      if (feature && feature.type === 'sketch') {
        this._lastSketchFeatureId = feature.id;
      }
      this._parametersPanel.showFeature(feature);
      this._showLeftFeatureParams(feature);
    });

    this._featurePanel.setOnFeatureToggle((feature) => {
      this._update3DView();
    });

    this._featurePanel.setOnFeatureDelete((featureId) => {
      this._parametersPanel.clear();
      this._showLeftFeatureParams(null);
      this._update3DView();
    });

    // Listen to part changes
    this._partManager.addListener((part) => {
      this._featurePanel.update();
      this._updateNodeTree();
      this._update3DView();
      this._updateOperationButtons();
    });

    // Add Sketch to Part
    document.getElementById('btn-add-sketch').addEventListener('click', (e) => {
      const firstFace = this._selectedFaces.size > 0 ? this._selectedFaces.values().next().value : null;
      if (firstFace && firstFace.face) {
        // Use selected face's plane
        const planeDef = this._getPlaneFromFace(firstFace);
        if (planeDef) {
          this._addSketchToPartWithPlane(planeDef);
          this._selectedFaces.clear();
          if (this._renderer3d) this._renderer3d.clearFaceSelection();
          return;
        }
      }
      if (this._selectedPlane) {
        // Use pre-selected plane directly
        this._addSketchToPart(this._selectedPlane);
      } else {
        // Show tooltip hint then plane selector context menu
        this._showPlaneSelectionTooltip(e.currentTarget);
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
      await this._startExtrude(false);
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

    // Chamfer
    const btnChamfer = document.getElementById('btn-chamfer');
    if (btnChamfer) {
      btnChamfer.addEventListener('click', () => {
        this._startChamfer();
      });
    }

    // Fillet
    const btnFillet = document.getElementById('btn-fillet');
    if (btnFillet) {
      btnFillet.addEventListener('click', () => {
        this._startFillet();
      });
    }
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
      `Sketch ${this._partManager.getFeatures().filter(f => f.type === 'sketch').length + 1}`,
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
      `Sketch ${this._partManager.getFeatures().filter(f => f.type === 'sketch').length + 1}`,
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

  /**
   * Show a tooltip near the given element prompting the user to select a plane or face.
   * The tooltip auto-dismisses after a few seconds.
   * @param {HTMLElement} anchor - Element to position near
   */
  _showPlaneSelectionTooltip(anchor) {
    // Remove any existing tooltip
    const existing = document.getElementById('plane-select-tooltip');
    if (existing) existing.remove();

    const tip = document.createElement('div');
    tip.id = 'plane-select-tooltip';
    tip.className = 'plane-select-tooltip';
    tip.textContent = 'Select a plane or face first, or choose one below';
    document.body.appendChild(tip);

    const rect = anchor.getBoundingClientRect();
    tip.style.left = `${rect.left}px`;
    tip.style.top = `${rect.bottom + 6}px`;

    // Auto-dismiss after 4 seconds
    setTimeout(() => { if (tip.parentNode) tip.remove(); }, 4000);
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

  /** Clear all 3D selections (face, plane, feature). */
  _deselectAll() {
    this._selectedFaces.clear();
    this._selectedPlane = null;
    if (this._renderer3d) {
      this._renderer3d.clearFaceSelection();
      this._renderer3d.setSelectedPlane(null);
      this._renderer3d.setSelectedFeature(null);
    }
    if (this._featurePanel) this._featurePanel.selectFeature(null);
    if (this._parametersPanel) this._parametersPanel.clear();
    this._showLeftFeatureParams(null);
  }

  _update3DView() {
    if (!this._renderer3d) return;

    // Trigger debounced save whenever the 3D view updates in Part mode
    if (this._workspaceMode === 'part') {
      debouncedSave();
    }

    const part = this._partManager.getPart();
    if (!part) {
      this._diagnosticBackfaceHatchAuto = false;
      this._applyDiagnosticBackfaceHatchState();
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
        activeTool: this.activeTool,
      });
      return;
    }

    try {
      const finalGeometry = part.getFinalGeometry();
      const geometry = finalGeometry && finalGeometry.geometry ? finalGeometry.geometry : null;
      this._diagnosticBackfaceHatchAuto = this._hasMeshHoles(geometry);
      this._applyDiagnosticBackfaceHatchState();

      const hadGeometry = this._renderer3d.hasGeometry();
      this._renderer3d.renderPart(part);
      // Only auto-fit the camera when geometry first appears; subsequent
      // updates preserve the user's camera orientation and zoom.
      if (!hadGeometry && this._renderer3d.hasGeometry()) {
        this._renderer3d.fitToView();
      }
    } catch (err) {
      error('Failed to render 3D part:', err);
      this.setStatus('Error rendering 3D part');
    }
  }

  // ---------------------------------------------------------------------------
  // Recording Bar & Command Bar visibility toggles (localStorage-backed)
  // ---------------------------------------------------------------------------

  _applyBarVisibility() {
    const recBar = document.getElementById('recording-bar');
    const cmdBar = document.getElementById('command-line');
    if (recBar) recBar.style.display = this._recordingBarVisible ? '' : 'none';
    if (cmdBar) cmdBar.style.display = this._commandBarVisible ? '' : 'none';
    this._syncBarToggleUI();
    this._recalcBottomOffsets();
  }

  _recalcBottomOffsets() {
    // Bottom layout stack (from bottom): command-line 28px → recording-bar 32px → status-bar 28px
    const cmdH = this._commandBarVisible ? 28 : 0;
    const recH = this._recordingBarVisible ? 32 : 0;
    const statusH = 28; // always visible

    const cmdBar = document.getElementById('command-line');
    const recBar = document.getElementById('recording-bar');
    const statusBar = document.getElementById('status-bar');

    if (cmdBar) cmdBar.style.bottom = '0px';
    if (recBar) recBar.style.bottom = cmdH + 'px';
    if (statusBar) statusBar.style.bottom = (cmdH + recH) + 'px';

    document.documentElement.style.setProperty('--bottom-offset', (cmdH + recH + statusH) + 'px');
  }

  _toggleRecordingBar() {
    this._recordingBarVisible = !this._recordingBarVisible;
    try { localStorage.setItem(RECORDING_BAR_VISIBLE_KEY, this._recordingBarVisible ? 'true' : 'false'); } catch {}
    this._applyBarVisibility();
  }

  _toggleCommandBar() {
    this._commandBarVisible = !this._commandBarVisible;
    try { localStorage.setItem(COMMAND_BAR_VISIBLE_KEY, this._commandBarVisible ? 'true' : 'false'); } catch {}
    this._applyBarVisibility();
  }

  _syncBarToggleUI() {
    const recBtn = document.getElementById('menu-toggle-recording-bar');
    const cmdBtn = document.getElementById('menu-toggle-command-bar');
    if (recBtn) recBtn.textContent = this._recordingBarVisible ? 'Hide Recording Bar' : 'Show Recording Bar';
    if (cmdBtn) cmdBtn.textContent = this._commandBarVisible ? 'Hide Command Bar' : 'Show Command Bar';
  }

  _loadDiagnosticBackfaceHatchMode() {
    try {
      const stored = localStorage.getItem(DIAGNOSTIC_HATCH_STORAGE_KEY);
      if (stored === DIAGNOSTIC_HATCH_MODE_ON || stored === DIAGNOSTIC_HATCH_MODE_OFF) {
        return stored;
      }
      if (stored === 'true') {
        return DIAGNOSTIC_HATCH_MODE_ON;
      }
      if (stored === 'false') {
        return DIAGNOSTIC_HATCH_MODE_OFF;
      }
      return DIAGNOSTIC_HATCH_MODE_AUTO;
    } catch {
      return DIAGNOSTIC_HATCH_MODE_AUTO;
    }
  }

  _saveDiagnosticBackfaceHatchMode() {
    try {
      localStorage.setItem(DIAGNOSTIC_HATCH_STORAGE_KEY, this._diagnosticBackfaceHatchMode);
    } catch {}
  }

  _effectiveDiagnosticBackfaceHatchEnabled() {
    if (this._diagnosticBackfaceHatchMode === DIAGNOSTIC_HATCH_MODE_ON) return true;
    if (this._diagnosticBackfaceHatchMode === DIAGNOSTIC_HATCH_MODE_OFF) return false;
    return !!this._diagnosticBackfaceHatchAuto;
  }

  _applyDiagnosticBackfaceHatchState() {
    if (this._renderer3d) {
      this._renderer3d.setDiagnosticBackfaceHatchEnabled(this._effectiveDiagnosticBackfaceHatchEnabled());
    }
    this._syncDiagnosticHatchUI();
  }

  _syncDiagnosticHatchUI() {
    const btn = document.getElementById('menu-toggle-diagnostic-hatch');
    if (!btn) return;
    const auto = this._diagnosticBackfaceHatchAuto;
    const mode = this._diagnosticBackfaceHatchMode;
    const effective = this._effectiveDiagnosticBackfaceHatchEnabled();
    let suffix = '';
    if (mode === DIAGNOSTIC_HATCH_MODE_AUTO) {
      suffix = auto ? ' (Auto)' : '';
    } else if (auto) {
      suffix = ' (Override)';
    }
    btn.textContent = `${effective ? 'Hide' : 'Show'} Inner Face Hatch${suffix}`;
    btn.classList.toggle('active', effective);
    btn.title = auto
      ? 'Toggle diagnostic hatch for inner/back faces. Holes or non-manifold edges were detected on the current solid.'
      : 'Toggle diagnostic hatch for inner/back faces';
  }

  _toggleDiagnosticBackfaceHatchPref() {
    const effective = this._effectiveDiagnosticBackfaceHatchEnabled();
    this._diagnosticBackfaceHatchMode = effective ? DIAGNOSTIC_HATCH_MODE_OFF : DIAGNOSTIC_HATCH_MODE_ON;
    this._saveDiagnosticBackfaceHatchMode();
    this._applyDiagnosticBackfaceHatchState();
    this._scheduleRender();
  }

  _hasMeshHoles(geometry) {
    if (!geometry || !geometry.faces || geometry.faces.length === 0) return false;
    const edgeCounts = new Map();
    const vertexKey = (v) => `${v.x.toFixed(5)},${v.y.toFixed(5)},${v.z.toFixed(5)}`;
    for (const face of geometry.faces) {
      const verts = face.vertices || [];
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const ka = vertexKey(a);
        const kb = vertexKey(b);
        const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        edgeCounts.set(ek, (edgeCounts.get(ek) || 0) + 1);
      }
    }
    let boundaryEdges = 0;
    let nonManifoldEdges = 0;
    for (const count of edgeCounts.values()) {
      if (count === 1) boundaryEdges++;
      else if (count > 2) nonManifoldEdges++;
    }
    return boundaryEdges > 0 || nonManifoldEdges > 0;
  }

  _isOriginPlaneVisible(planeName) {
    const part = this._partManager.getPart();
    if (!part || !planeName) return false;
    const originPlanes = part.getOriginPlanes ? part.getOriginPlanes() : null;
    return !!(originPlanes && originPlanes[planeName] && originPlanes[planeName].visible);
  }

  _serializeSessionState() {
    return {
      sketchingOnPlane: this._sketchingOnPlane,
      activeSketchPlane: this._activeSketchPlane,
      activeSketchPlaneDef: this._activeSketchPlaneDef,
      editingSketchFeatureId: this._editingSketchFeatureId,
      lastSketchFeatureId: this._lastSketchFeatureId,
      savedOrbitState: this._savedOrbitState,
      expandedFolders: Array.from(this._expandedFolders || []),
      rollbackIndex: this._rollbackIndex,
    };
  }

  _restoreSessionState(sessionState) {
    if (!sessionState) return;

    this._expandedFolders = new Set(Array.isArray(sessionState.expandedFolders) ? sessionState.expandedFolders : []);
    if (typeof sessionState.rollbackIndex === 'number') {
      this._rollbackIndex = sessionState.rollbackIndex;
    }

    if (!sessionState.sketchingOnPlane) return;

    this._sketchingOnPlane = true;
    this._activeSketchPlane = sessionState.activeSketchPlane || null;
    this._activeSketchPlaneDef = sessionState.activeSketchPlaneDef
      || (this._activeSketchPlane && this._activeSketchPlane !== 'FACE'
        ? this._getPlaneDefinition(this._activeSketchPlane)
        : null);
    this._editingSketchFeatureId = sessionState.editingSketchFeatureId || null;
    this._lastSketchFeatureId = sessionState.lastSketchFeatureId || this._editingSketchFeatureId || null;
    this._savedOrbitState = sessionState.savedOrbitState || null;
    this._selectedPlane = null;
    this._selectedFaces.clear();
    this._hoveredPlane = null;
    this._3dMode = true;

    document.body.classList.add('sketch-on-plane');

    const exitBtn = document.getElementById('btn-exit-sketch');
    if (exitBtn) exitBtn.style.display = 'flex';

    const part = this._partManager.getPart();
    if (part) {
      part.setActiveSketch(this._editingSketchFeatureId);
    }

    if (this._renderer3d) {
      this._renderer3d.setMode('3d');
      this._renderer3d.setVisible(true);
      this._renderer3d._sketchPlane = this._activeSketchPlane;
      this._renderer3d._sketchPlaneDef = this._activeSketchPlaneDef;
      this._renderer3d.setSelectedPlane(null);
      this._renderer3d.setHoveredPlane(null);
    }

    const modeIndicator = document.getElementById('status-mode');
    if (this._editingSketchFeatureId && part) {
      const sketchFeature = part.getFeature(this._editingSketchFeatureId);
      const sketchName = sketchFeature ? sketchFeature.name : 'Sketch';
      modeIndicator.textContent = `EDIT SKETCH: ${sketchName}`;
      this.setStatus(`Editing ${sketchName}. Modify, then Exit Sketch to apply changes.`);
    } else {
      modeIndicator.textContent = this._activeSketchPlane === 'FACE'
        ? 'SKETCH ON FACE'
        : `SKETCH ON ${this._activeSketchPlane || 'PLANE'}`;
      this.setStatus('Sketch session restored.');
    }
    modeIndicator.className = 'status-mode sketch-mode';

    this.setActiveTool('select');

    // Orient camera to the sketch plane normal
    this._orientToNormalView();
  }

  _createNewDrawing() {
    state.clearAll();
    clearSavedProject();

    this.renderer.hoverEntity = null;
    this.renderer.previewEntities = [];
    this.renderer.snapPoint = null;
    this.renderer.cursorWorld = null;

    this._selectedFaces.clear();
    this._selectedPlane = null;
    this._hoveredPlane = null;
    this._activeSketchPlane = null;
    this._activeSketchPlaneDef = null;
    this._scenes = [];
    if (this._sceneManagerOpen) this._renderSceneList();
    this._editingSketchFeatureId = null;
    this._lastSketchFeatureId = null;
    this._savedOrbitState = null;
    this._sketchingOnPlane = false;
    this._expandedFolders.clear();
    this._rollbackIndex = -1;

    document.body.classList.remove('sketch-on-plane');
    const exitBtn = document.getElementById('btn-exit-sketch');
    if (exitBtn) exitBtn.style.display = 'none';

    if (this._renderer3d) {
      this._renderer3d._sketchPlane = null;
      this._renderer3d._sketchPlaneDef = null;
      this._renderer3d.setSelectedPlane(null);
      this._renderer3d.setHoveredPlane(null);
      this._renderer3d.setSelectedFeature(null);
      this._renderer3d.selectFace(-1);
    }

    if (this._workspaceMode === 'part') {
      this._partManager.createPart('Part1');
      const modeIndicator = document.getElementById('status-mode');
      modeIndicator.textContent = 'PART DESIGN';
      modeIndicator.className = 'status-mode part-mode';
    } else {
      this._partManager.part = null;
      this._partManager.activeFeature = null;
    }

    if (this._featurePanel) {
      this._featurePanel.selectedFeatureId = null;
      this._featurePanel.update();
    }
    if (this._parametersPanel) this._parametersPanel.clear();
    this._showLeftFeatureParams(null);

    this._updateNodeTree();
    this._update3DView();
    this._updateOperationButtons();
    this._scheduleRender();
  }

  async _openCMODProject() {
    const result = await openCMODFile();
    if (!result.ok) {
      if (result.error) this.setStatus(result.error);
      return;
    }

    // Restore part
    if (result.part) {
      this._partManager.deserialize(result.part);
      if (!this._workspaceMode || this._workspaceMode !== 'part') {
        this._enterWorkspace('part');
      }
      if (result.sessionState) {
        this._restoreSessionState(result.sessionState);
      }
    }

    // Restore camera (skip if sketch mode — normal view was set by restore)
    if (result.orbit && this._renderer3d && !this._sketchingOnPlane) {
      this._renderer3d.setOrbitState(result.orbit);
    }

    // Restore named scenes
    this._scenes = result.scenes || [];
    if (this._sceneManagerOpen) this._renderSceneList();

    // Rebuild UI
    this._rebuildLayersPanel();
    this._rebuildLeftPanel();
    if (!result.hasViewport && state.entities.length > 0) {
      this.viewport.fitEntities(state.entities);
    }
    this._update3DView();
    this._updateNodeTree();
    this._updateOperationButtons();
    this._scheduleRender();
    debouncedSave();

    const name = result.filename || 'project';
    info('CMOD project loaded', { filename: name, metadata: result.metadata });
    this.setStatus(`Opened ${name}`);
  }

  async _populateExamplesMenu(container) {
    try {
      const resp = await fetch('tests/samples/examples.json');
      if (!resp.ok) { container.textContent = 'Failed to load'; return; }
      const examples = await resp.json();
      container.innerHTML = '';
      for (const ex of examples) {
        const btn = document.createElement('button');
        btn.dataset.file = ex.file;
        btn.textContent = ex.label;
        container.appendChild(btn);
      }
    } catch {
      container.textContent = 'Failed to load';
    }
  }

  async _loadExample(filename) {
    try {
      const resp = await fetch(`tests/samples/${filename}`);
      if (!resp.ok) { this.setStatus(`Failed to load example: ${resp.statusText}`); return; }
      const data = await resp.json();
      const result = projectFromCMOD(data);
      if (!result.ok) { this.setStatus(result.error || 'Failed to load example'); return; }

      if (result.part) {
        this._partManager.deserialize(result.part);
        if (this._workspaceMode !== 'part') this._enterWorkspace('part');
        if (result.sessionState) this._restoreSessionState(result.sessionState);
      }
      if (result.orbit && this._renderer3d && !this._sketchingOnPlane) this._renderer3d.setOrbitState(result.orbit);
      this._scenes = result.scenes || [];
      if (this._sceneManagerOpen) this._renderSceneList();

      this._rebuildLayersPanel();
      this._rebuildLeftPanel();
      if (!result.hasViewport && state.entities.length > 0) {
        this.viewport.fitEntities(state.entities);
      }
      this._update3DView();
      this._updateNodeTree();
      this._updateOperationButtons();
      this._scheduleRender();
      debouncedSave();
      this.setStatus(`Loaded example: ${filename}`);
    } catch (err) {
      this.setStatus(`Failed to load example: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Scene Manager
  // ---------------------------------------------------------------------------

  _bindSceneManagerEvents() {
    const closeBtn = document.getElementById('scene-manager-close');
    const addBtn = document.getElementById('scene-add');
    const downloadBtn = document.getElementById('scene-download-image');
    const galleryBtn = document.getElementById('scene-gallery');
    if (closeBtn) closeBtn.addEventListener('click', () => this._toggleSceneManager());
    if (addBtn) addBtn.addEventListener('click', () => this._addScene());
    if (downloadBtn) downloadBtn.addEventListener('click', () => this._downloadViewportImage());
    if (galleryBtn) galleryBtn.addEventListener('click', () => this.showSceneGallery());
  }

  _toggleSceneManager() {
    const panel = document.getElementById('scene-manager-panel');
    const sep = document.getElementById('scene-manager-sep');
    if (!panel) return;
    this._sceneManagerOpen = !this._sceneManagerOpen;
    const show = this._sceneManagerOpen;
    panel.style.display = show ? '' : 'none';
    if (sep) sep.style.display = show ? '' : 'none';
    document.body.classList.toggle('scene-manager-active', show);
    if (show) {
      // Clear all selection and hover highlights
      this._selectedFaces.clear();
      this._selectedPlane = null;
      if (this._renderer3d) {
        this._renderer3d.clearFaceSelection();
        this._renderer3d.clearEdgeSelection();
        this._renderer3d.setHoveredFace(-1);
        this._renderer3d.setHoveredEdge(-1);
        this._renderer3d.setSelectedPlane(null);
        this._renderer3d.setHoveredPlane(null);
        this._renderer3d.setSelectedFeature(null);
      }
      if (this._featurePanel) this._featurePanel.selectFeature(null);
      if (this._parametersPanel) this._parametersPanel.clear();
      this._hoveredPlane = null;
      this._renderSceneList();
      this._scheduleRender();
    }
  }

  _renderSceneList() {
    const list = document.getElementById('scene-list');
    if (!list) return;
    list.innerHTML = '';
    if (this._scenes.length === 0) {
      list.innerHTML = '<p class="hint">No scenes saved yet</p>';
      return;
    }
    this._scenes.forEach((scene, i) => {
      const item = document.createElement('div');
      item.className = 'scene-item';
      item.dataset.index = i;

      const name = document.createElement('span');
      name.className = 'scene-item-name';
      name.textContent = scene.name;
      name.title = 'Double-click to rename';
      name.addEventListener('dblclick', () => {
        name.contentEditable = 'true';
        name.focus();
        const sel = window.getSelection();
        sel.selectAllChildren(name);
      });
      const commitRename = () => {
        name.contentEditable = 'false';
        const newName = name.textContent.trim();
        if (newName && newName !== scene.name) {
          scene.name = newName;
          debouncedSave();
        } else {
          name.textContent = scene.name;
        }
      };
      name.addEventListener('blur', commitRename);
      name.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); name.blur(); }
        if (e.key === 'Escape') { name.textContent = scene.name; name.blur(); }
      });

      const actions = document.createElement('span');
      actions.className = 'scene-item-actions';

      const applyBtn = document.createElement('button');
      applyBtn.textContent = '▶';
      applyBtn.title = 'Apply this scene';
      applyBtn.addEventListener('click', (e) => { e.stopPropagation(); this._applyScene(i); });

      const delBtn = document.createElement('button');
      delBtn.textContent = '✕';
      delBtn.title = 'Delete this scene';
      delBtn.addEventListener('click', (e) => { e.stopPropagation(); this._deleteScene(i); });

      actions.appendChild(applyBtn);
      actions.appendChild(delBtn);
      item.appendChild(name);
      item.appendChild(actions);
      item.addEventListener('click', () => this._applyScene(i));
      list.appendChild(item);
    });
  }

  _addScene() {
    if (!this._renderer3d) return;
    const defaultName = `Scene ${this._scenes.length + 1}`;
    const name = prompt('Scene name:', defaultName);
    if (!name) return;
    const orbit = this._renderer3d.getOrbitState();
    this._scenes.push({ name, orbit });
    this._renderSceneList();
    debouncedSave();
    this.setStatus(`Scene "${name}" saved`);
  }

  _applyScene(index) {
    const scene = this._scenes[index];
    if (!scene || !this._renderer3d) return;
    this._renderer3d.setOrbitState(scene.orbit);
    this._scheduleRender();
    // Highlight active item
    const items = document.querySelectorAll('#scene-list .scene-item');
    items.forEach((el, i) => el.classList.toggle('active', i === index));
    this.setStatus(`Applied scene "${scene.name}"`);
  }

  _deleteScene(index) {
    const scene = this._scenes[index];
    if (!scene) return;
    this._scenes.splice(index, 1);
    this._renderSceneList();
    debouncedSave();
    this.setStatus(`Deleted scene "${scene.name}"`);
  }

  _downloadViewportImage() {
    if (!this._renderer3d) { this.setStatus('3D renderer not available'); return; }
    const dataUrl = this._renderer3d.captureImage();
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'viewport.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    this.setStatus('Image downloaded');
  }

  // ---------------------------------------------------------------------------
  // Scene Gallery — render all scenes into a grid preview
  // ---------------------------------------------------------------------------

  /**
   * Render all saved scenes into a composite grid image.
   * Each cell is rendered at the given cellWidth × cellHeight.
   * Returns a PNG data URL of the full grid, or null if no scenes.
   * @param {object} [opts]
   * @param {number} [opts.cellWidth=320]  - width of each cell in px
   * @param {number} [opts.cellHeight=240] - height of each cell in px
   * @param {number} [opts.columns=0]      - columns (0 = auto sqrt)
   * @returns {string|null} PNG data URL or null
   */
  renderSceneGallery(opts = {}) {
    if (!this._renderer3d || this._scenes.length === 0) return null;

    const cellW = opts.cellWidth || 320;
    const cellH = opts.cellHeight || 240;
    const count = this._scenes.length;
    const cols = opts.columns || Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);

    const r = this._renderer3d;

    // Save current state so we can restore after
    const savedOrbit = r.getOrbitState();
    const origW = r.canvas.width;
    const origH = r.canvas.height;
    const origCssW = r._cssWidth;
    const origCssH = r._cssHeight;
    const origOverW = r.overlayCanvas.width;
    const origOverH = r.overlayCanvas.height;
    const origStyleW = r.canvas.style.width;
    const origStyleH = r.canvas.style.height;

    // Resize renderer to cell dimensions through the proper pipeline
    r.canvas.width = cellW;
    r.canvas.height = cellH;
    r.canvas.style.width = cellW + 'px';
    r.canvas.style.height = cellH + 'px';
    r.overlayCanvas.width = cellW;
    r.overlayCanvas.height = cellH;
    r.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    r._cssWidth = cellW;
    r._cssHeight = cellH;
    r.executor.resize(cellW, cellH);
    if (r._ready) r.wasm.resize(cellW, cellH);

    // Composite grid canvas
    const grid = document.createElement('canvas');
    grid.width = cols * cellW;
    grid.height = rows * cellH;
    const gctx = grid.getContext('2d');
    gctx.fillStyle = '#1e1e1e';
    gctx.fillRect(0, 0, grid.width, grid.height);

    for (let i = 0; i < count; i++) {
      const scene = this._scenes[i];
      r.setOrbitState(scene.orbit);
      r._renderFrame();

      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = col * cellW;
      const y = row * cellH;

      gctx.drawImage(r.canvas, x, y, cellW, cellH);
      gctx.drawImage(r.overlayCanvas, x, y, cellW, cellH);

      // Draw scene name label
      gctx.save();
      gctx.fillStyle = 'rgba(0,0,0,0.55)';
      gctx.fillRect(x, y + cellH - 28, cellW, 28);
      gctx.fillStyle = '#fff';
      gctx.font = '13px Inter, system-ui, sans-serif';
      gctx.fillText(scene.name, x + 8, y + cellH - 9);
      gctx.restore();
    }

    // Restore original state through proper pipeline
    const dpr = window.devicePixelRatio || 1;
    r.canvas.width = origW;
    r.canvas.height = origH;
    r.canvas.style.width = origStyleW;
    r.canvas.style.height = origStyleH;
    r.overlayCanvas.width = origOverW;
    r.overlayCanvas.height = origOverH;
    r.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    r._cssWidth = origCssW;
    r._cssHeight = origCssH;
    r.executor.resize(origW, origH);
    if (r._ready) r.wasm.resize(origW, origH);
    r.setOrbitState(savedOrbit);
    r._renderFrame();

    return grid.toDataURL('image/png');
  }

  /**
   * Open a gallery window/overlay showing all scenes in a grid.
   */
  showSceneGallery() {
    const dataUrl = this.renderSceneGallery();
    if (!dataUrl) {
      this.setStatus('No scenes to preview');
      return;
    }
    // Open in a new window so it doesn't obstruct the viewport
    const w = window.open('', '_blank', 'width=900,height=700');
    if (!w) { this.setStatus('Popup blocked — allow popups for gallery'); return; }
    w.document.title = 'Scene Gallery';
    w.document.body.style.cssText = 'margin:0;background:#1e1e1e;display:flex;align-items:center;justify-content:center;min-height:100vh';
    const img = w.document.createElement('img');
    img.src = dataUrl;
    img.style.cssText = 'max-width:100%;height:auto';
    w.document.body.appendChild(img);
  }

  /**
   * Download the scene gallery grid as a PNG file.
   * @param {object} [opts] - same options as renderSceneGallery
   */
  downloadSceneGallery(opts) {
    const dataUrl = this.renderSceneGallery(opts);
    if (!dataUrl) { this.setStatus('No scenes to preview'); return; }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'scene-gallery.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    this.setStatus('Scene gallery downloaded');
  }

  _exportDXFFromFaces() {
    if (!this._renderer3d) { this.setStatus('3D renderer not available'); return; }

    // Show export panel in left sidebar
    const container = document.getElementById('left-feature-params-content');
    if (!container) return;

    if (this._dxfExportPanel) this._dxfExportPanel.destroy();
    this._dxfExportPanel = new DxfExportPanel({
      getSelectedFaces: () => this._selectedFaces,
      getRenderer: () => this._renderer3d,
      onExit: () => this._closeDxfExportPanel(),
      setStatus: (msg) => this.setStatus(msg),
      buildSelectionList: () => this._buildSelectionList(),
    });
    this._dxfExportPanel.build(container);
  }

  _closeDxfExportPanel() {
    if (this._dxfExportPanel) {
      this._dxfExportPanel.destroy();
      this._dxfExportPanel = null;
    }
    this._showLeftFeatureParams(null);
  }

  async _importDXFToSketch() {
    if (!this._sketchingOnPlane) {
      this.setStatus('Start a sketch first before importing DXF');
      return;
    }
    const picked = await pickDXFFile();
    if (!picked) return;

    const { items, filename } = picked;
    if (!items || items.length === 0) {
      this.setStatus('DXF file contains no geometry');
      return;
    }
    const bounds = dxfBounds(items);
    const scaleStr = await showPrompt({
      title: 'Import DXF',
      message: `File: ${filename}\n${items.length} entities (${bounds.width.toFixed(1)} × ${bounds.height.toFixed(1)})\n\nScale factor:`,
      defaultValue: '1',
    });
    if (scaleStr === null || scaleStr === undefined) return;
    const scale = parseFloat(scaleStr) || 1;

    const count = addDXFToScene(items, { offsetX: 0, offsetY: 0, scale, centerOnOrigin: true });
    takeSnapshot();
    this.viewport.fitEntities(state.entities);
    this._scheduleRender();
    this.setStatus(`Imported ${count} entities from ${filename} (scale ${scale})`);
  }

  _updateNodeTree() {
    const container = document.getElementById('node-tree-features');
    if (!container) return;
    
    const features = this._partManager.getFeatures();
    container.innerHTML = '';

    // Update origin plane rows (predefined in index.html) with visibility toggles
    const part = this._partManager.getPart();
    if (part) {
      const originPlanes = part.getOriginPlanes();
      ['XY', 'XZ', 'YZ'].forEach((planeName) => {
        const planeState = originPlanes[planeName];
        const planeEl = document.querySelector(`#node-tree-origin-planes .node-tree-plane[data-plane="${planeName}"]`);
        if (!planeEl) return;

        const isVisible = !!planeState.visible;
        if (!isVisible && this._selectedPlane === planeName) {
          this._selectedPlane = null;
          if (this._renderer3d) this._renderer3d.setSelectedPlane(null);
        }
        if (!isVisible && this._hoveredPlane === planeName) {
          this._hoveredPlane = null;
          if (this._renderer3d) this._renderer3d.setHoveredPlane(null);
        }

        planeEl.classList.toggle('selected', isVisible && this._selectedPlane === planeName);
        planeEl.classList.toggle('inactive', !isVisible);
        planeEl.classList.toggle('hovered', isVisible && this._hoveredPlane === planeName);

        let eyeEl = planeEl.querySelector('.node-tree-eye');
        if (!eyeEl) {
          eyeEl = document.createElement('span');
          eyeEl.className = 'node-tree-eye';
          const iconEl = planeEl.querySelector('.node-tree-icon');
          if (iconEl) planeEl.insertBefore(eyeEl, iconEl);
          else planeEl.insertBefore(eyeEl, planeEl.firstChild);
        }

        eyeEl.textContent = planeState.visible ? '👁' : '—';
        eyeEl.setAttribute('data-plane-toggle', planeName);
        eyeEl.title = `Toggle ${planeName} plane visibility`;
        eyeEl.onclick = (e) => {
          e.stopPropagation();
          part.setOriginPlaneVisible(planeName, !planeState.visible);
          this._updateNodeTree();
          this._update3DView();
          this._scheduleRender();
        };

        planeEl.onclick = (e) => {
          if (e.target && e.target.classList && e.target.classList.contains('node-tree-eye')) return;
          if (this._workspaceMode !== 'part') return;
          if (this._isEditingFeature()) return;
          if (!isVisible) return;
          if (this._selectedPlane === planeName) {
            this._selectedPlane = null;
          } else {
            this._selectedPlane = planeName;
          }
          // Sync highlight to 3D renderer
          if (this._renderer3d) {
            this._renderer3d.setSelectedPlane(this._selectedPlane);
          }
          this._updateNodeTree();
          this._scheduleRender();
        };
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

    // Build a set of feature IDs that are consumed as children of other features
    const consumedIds = new Set();
    features.forEach((f) => {
      if (f.children && f.children.length > 0) {
        f.children.forEach((childId) => consumedIds.add(childId));
      }
    });

    // Determine the rollback position (index of features that are active)
    // _rollbackIndex === -1 means all features are active (bar is at bottom)
    const rollbackPos = this._rollbackIndex < 0 ? features.length : this._rollbackIndex;

    // Helper: build a feature row element
    const buildFeatureRow = (feature, isChild, featureIndex) => {
      const isBelowRollback = featureIndex >= rollbackPos;
      const div = document.createElement('div');
      div.className = isChild ? 'node-tree-feature node-tree-child-feature' : 'node-tree-feature';
      if (feature.suppressed || isBelowRollback) div.classList.add('suppressed');
      if (isBelowRollback) div.classList.add('rolled-back');
      if (this._featurePanel && this._featurePanel.selectedFeatureId === feature.id) {
        div.classList.add('active');
      }

      const icon = getFeatureIconSVG(feature.type);
      const eyeIcon = feature.visible ? '👁' : '—';
      const hiddenTag = feature.visible ? '' : ' <span class="node-tree-hidden-indicator" title="Hidden">[hidden]</span>';
      div.innerHTML = `<span class="node-tree-eye" title="Toggle feature visibility">${eyeIcon}</span><span class="node-tree-icon">${icon}</span><span class="node-tree-label">${feature.name}${hiddenTag}</span>`;

      const eyeEl = div.querySelector('.node-tree-eye');
      if (eyeEl) {
        eyeEl.addEventListener('click', (e) => {
          e.stopPropagation();
          feature.setVisible(!feature.visible);
          if (this._featurePanel) this._featurePanel.update();
          this._updateNodeTree();
          this._update3DView();
          this._scheduleRender();
        });
      }

      div.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this._isEditingFeature()) return;
        if (feature.type === 'sketch') {
          this._lastSketchFeatureId = feature.id;
        }
        if (this._featurePanel) {
          this._featurePanel.selectFeature(feature.id);
        } else {
          if (this._parametersPanel) {
            this._parametersPanel.showFeature(feature);
          }
          this._showLeftFeatureParams(feature);
        }
        // Highlight selected feature in 3D view
        if (this._renderer3d) {
          this._renderer3d.setSelectedFeature(feature.id);
        }
        this._recorder.featureSelected(feature.id, feature.type, feature.name);
        this._updateNodeTree();
        this._update3DView();
        this._scheduleRender();
      });

      // Double-click on sketch features to enter edit mode
      div.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        if (this._isEditingFeature()) return;
        if (feature.type === 'sketch') {
          this._recorder.sketchEditStarted(feature.id, feature.name);
          this._editExistingSketch(feature);
        } else if (feature.type === 'extrude' || feature.type === 'extrude-cut') {
          this._editExtrude(feature);
        }
      });

      // Right-click context menu
      div.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (this._isEditingFeature()) return;
        const ctxItems = [];

        // Edit (sketch only)
        if (feature.type === 'sketch') {
          ctxItems.push({
            type: 'item', label: 'Edit Sketch', icon: '✏️',
            disabled: this._sketchingOnPlane,
            action: () => {
              this._recorder.sketchEditStarted(feature.id, feature.name);
              this._editExistingSketch(feature);
            }
          });
        }

        // Rename
        ctxItems.push({
          type: 'item', label: 'Rename', icon: '📝',
          action: () => {
            const newName = prompt('Rename feature:', feature.name);
            if (newName && newName.trim()) {
              feature.name = newName.trim();
              this._partManager.notifyListeners();
            }
          }
        });

        ctxItems.push({ type: 'separator' });

        // Suppress / Unsuppress
        if (feature.suppressed) {
          ctxItems.push({
            type: 'item', label: 'Unsuppress', icon: '👁',
            action: () => {
              this._partManager.unsuppressFeature(feature.id);
              this._update3DView();
            }
          });
        } else {
          ctxItems.push({
            type: 'item', label: 'Suppress', icon: '🚫',
            action: () => {
              this._partManager.suppressFeature(feature.id);
              this._update3DView();
            }
          });
        }

        ctxItems.push({ type: 'separator' });

        // Delete
        ctxItems.push({
          type: 'item', label: 'Delete', icon: '🗑️',
          action: () => {
            if (!confirm('Delete this feature? This cannot be undone.')) return;
            this._partManager.removeFeature(feature.id);
            if (this._featurePanel && this._featurePanel.selectedFeatureId === feature.id) {
              this._featurePanel.selectedFeatureId = null;
            }
            if (this._parametersPanel) this._parametersPanel.clear();
            this._showLeftFeatureParams(null);
            this._update3DView();
          }
        });

        showContextMenu(e.clientX, e.clientY, ctxItems);
      });

      return div;
    };

    // Track the flat visual index to place the rollback bar correctly
    let flatIndex = 0;
    const allRows = []; // {element, flatIdx}

    features.forEach((feature) => {
      // Skip features that are consumed as children (shown nested under parent)
      if (consumedIds.has(feature.id)) return;

      const featureIndex = features.indexOf(feature);
      const hasChildren = feature.children && feature.children.length > 0;

      if (hasChildren) {
        // Create a collapsible folder wrapper
        const wrapper = document.createElement('div');
        wrapper.className = 'node-tree-folder';

        // Check if folder is expanded (default collapsed)
        const folderId = `folder-${feature.id}`;
        const isExpanded = this._expandedFolders && this._expandedFolders.has(folderId);

        // Parent feature row with toggle arrow
        const div = buildFeatureRow(feature, false, featureIndex);
        // Prepend a toggle arrow before the eye icon
        const arrow = document.createElement('span');
        arrow.className = 'node-tree-folder-arrow';
        arrow.textContent = isExpanded ? '▾' : '▸';
        arrow.addEventListener('click', (e) => {
          e.stopPropagation();
          if (this._expandedFolders.has(folderId)) {
            this._expandedFolders.delete(folderId);
          } else {
            this._expandedFolders.add(folderId);
          }
          this._updateNodeTree();
        });
        div.insertBefore(arrow, div.firstChild);

        wrapper.appendChild(div);

        // Children container (only visible when expanded)
        if (isExpanded) {
          const childContainer = document.createElement('div');
          childContainer.className = 'node-tree-children';
          feature.children.forEach((childId) => {
            const childFeature = features.find((f) => f.id === childId);
            if (childFeature) {
              childContainer.appendChild(buildFeatureRow(childFeature, true, features.indexOf(childFeature)));
            }
          });
          wrapper.appendChild(childContainer);
        }

        allRows.push({ element: wrapper, flatIdx: flatIndex });
        flatIndex++;
      } else {
        allRows.push({ element: buildFeatureRow(feature, false, featureIndex), flatIdx: flatIndex });
        flatIndex++;
      }
    });

    // Determine where to insert the rollback bar among the visible rows
    // The rollback bar position maps to the feature index in the flat features array
    // We need to map rollbackPos to the visual row index
    let rollbackRowIdx = allRows.length; // default: at the bottom
    if (rollbackPos < features.length) {
      // Find the visual row that corresponds to the first rolled-back feature
      const rolledBackFeature = features[rollbackPos];
      if (rolledBackFeature) {
        // If the rolled-back feature is consumed as a child, find its parent
        const matchIdx = allRows.findIndex((r) => {
          const el = r.element;
          return el.querySelector(`[data-feature-id="${rolledBackFeature.id}"]`) !== null ||
                 el.dataset?.featureId === rolledBackFeature.id;
        });
        // Fallback: use feature counting
        if (matchIdx >= 0) {
          rollbackRowIdx = matchIdx;
        } else {
          // Map by counting non-consumed features up to rollbackPos
          let count = 0;
          for (let i = 0; i < rollbackPos; i++) {
            if (!consumedIds.has(features[i].id)) count++;
          }
          rollbackRowIdx = count;
        }
      }
    }

    // Build the rollback bar element
    const rollbackBar = document.createElement('div');
    rollbackBar.className = 'node-tree-rollback-bar';
    rollbackBar.title = 'Drag to roll back / forward features';

    // Drag handling for the rollback bar
    let dragStartY = 0;
    let dragStartIndex = rollbackPos;

    const onDragMove = (e) => {
      rollbackBar.classList.add('dragging');
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      const deltaY = clientY - dragStartY;
      // Each row is approximately 24px tall
      const rowHeight = 24;
      const indexDelta = Math.round(deltaY / rowHeight);
      let newIndex = dragStartIndex + indexDelta;
      newIndex = Math.max(0, Math.min(features.length, newIndex));
      if (newIndex !== this._rollbackIndex && !(newIndex === features.length && this._rollbackIndex === -1)) {
        this._rollbackIndex = newIndex >= features.length ? -1 : newIndex;
        this._applyRollbackSuppression();
        // notifyListeners in _applyRollbackSuppression triggers _updateNodeTree, _update3DView
        this._scheduleRender();
      }
    };

    const onDragEnd = () => {
      rollbackBar.classList.remove('dragging');
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragEnd);
      document.removeEventListener('touchmove', onDragMove);
      document.removeEventListener('touchend', onDragEnd);
    };

    rollbackBar.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragStartY = e.clientY;
      dragStartIndex = this._rollbackIndex < 0 ? features.length : this._rollbackIndex;
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
    });

    rollbackBar.addEventListener('touchstart', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragStartY = e.touches[0].clientY;
      dragStartIndex = this._rollbackIndex < 0 ? features.length : this._rollbackIndex;
      document.addEventListener('touchmove', onDragMove, { passive: false });
      document.addEventListener('touchend', onDragEnd);
    });

    // Insert rows and the rollback bar into the container
    for (let i = 0; i < allRows.length; i++) {
      if (i === rollbackRowIdx) {
        container.appendChild(rollbackBar);
      }
      container.appendChild(allRows[i].element);
    }
    // If bar is at the bottom (all features active)
    if (rollbackRowIdx >= allRows.length) {
      container.appendChild(rollbackBar);
    }
  }

  /**
   * Apply rollback suppression: suppress features at/after _rollbackIndex,
   * unsuppress features before _rollbackIndex.
   */
  _applyRollbackSuppression() {
    const features = this._partManager.getFeatures();
    if (features.length === 0) return;
    const pos = this._rollbackIndex < 0 ? features.length : this._rollbackIndex;
    for (let i = 0; i < features.length; i++) {
      if (i < pos) {
        if (features[i].suppressed) features[i].unsuppress();
      } else {
        if (!features[i].suppressed) features[i].suppress();
      }
    }
    // Re-execute the feature tree
    const part = this._partManager.getPart();
    if (part) {
      part.featureTree.executeAll();
      part.modified = new Date();
    }
    this._partManager.notifyListeners();
  }

  _updateOperationButtons() {
    // Sync the locked/unlocked visual state on feature trees
    this._syncFeatureTreeLocked();

    const hasSketch = this._lastSketchFeatureId !== null;
    const hasEntities = state.entities.length > 0;
    const inExtrude = !!this._extrudeMode;
    const inChamfer = !!this._chamferMode;
    const inFillet = !!this._filletMode;
    const busy = inExtrude || inChamfer || inFillet;
    const hasSolid = this._partManager && this._partManager.getFeatures().some(
      f => f.type === 'extrude' || f.type === 'extrude-cut' || f.type === 'revolve'
    );
    
    const btnAddSketch = document.getElementById('btn-add-sketch');
    if (btnAddSketch) btnAddSketch.disabled = !hasEntities || busy;
    const btnExtrude = document.getElementById('btn-extrude');
    if (btnExtrude) btnExtrude.disabled = busy;
    const btnRevolve = document.getElementById('btn-revolve');
    if (btnRevolve) btnRevolve.disabled = !hasSketch || busy;
    const btnExtrudeCut = document.getElementById('btn-extrude-cut');
    if (btnExtrudeCut) btnExtrudeCut.disabled = busy;
    const btnChamfer = document.getElementById('btn-chamfer');
    if (btnChamfer) btnChamfer.disabled = !hasSolid || busy;
    const btnFillet = document.getElementById('btn-fillet');
    if (btnFillet) btnFillet.disabled = !hasSolid || busy;
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

  _setStartupLoading(visible, label = null, progress = null) {
    const overlay = document.getElementById('startup-loading');
    if (!overlay) return;

    overlay.classList.toggle('hidden', !visible);

    const labelEl = document.getElementById('startup-loading-label');
    if (labelEl && label !== null) {
      labelEl.textContent = label;
    }

    const bar = document.getElementById('startup-loading-bar');
    const track = overlay.querySelector('.startup-loading-track');
    if (bar && progress !== null) {
      const clamped = Math.max(0, Math.min(100, progress));
      bar.style.width = `${clamped}%`;
      if (track) track.setAttribute('aria-valuenow', String(clamped));
    }
  }

  _bindQuickStartEvents() {
    const qsPart = document.getElementById('qs-part');
    const qsAssembly = document.getElementById('qs-assembly');

    if (qsPart) {
      qsPart.addEventListener('click', () => {
        this._enterWorkspace('part');
      });
    }

    if (qsAssembly) {
      qsAssembly.addEventListener('click', () => {
        // Assembly is a stub - show message
        this.setStatus('Assembly Design workspace is coming soon.');
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

    if (mode === 'part') {
      // Part Design workspace: unified 3D+sketch view
      // Only create a new Part if none exists (e.g. from deserialization)
      if (!this._partManager.getPart()) {
        this._partManager.createPart('Part1');
      }
      this._3dMode = true;
      if (this._renderer3d) {
        this._renderer3d.setMode('3d');
        this._renderer3d.setVisible(true);
      }
      const featurePanel = document.getElementById('feature-panel');
      const parametersPanel = document.getElementById('parameters-panel');
      // Feature panel stays hidden (node tree overlay handles feature tree now)
      parametersPanel.classList.add('active');
      modeIndicator.textContent = 'PART DESIGN';
      modeIndicator.className = 'status-mode part-mode';
      this.setActiveTool('select');
      this._updateOperationButtons();
      this._updateNodeTree();
      this._recorder.workspaceChanged(mode);
      info('Entered Part Design workspace');
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
        if (!this._isOriginPlaneVisible(plane)) return;
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
        // Sync highlight to 3D renderer
        if (this._renderer3d) {
          this._renderer3d.setSelectedPlane(this._selectedPlane);
        }
        info(`Plane selection: ${this._selectedPlane || 'none'}`);
        this._update3DView();
        this._scheduleRender();
      });

      // Hover sync from feature tree to 3D viewport
      item.addEventListener('mouseenter', () => {
        if (this._workspaceMode !== 'part') return;
        const plane = item.getAttribute('data-plane');
        if (!this._isOriginPlaneVisible(plane)) return;
        this._hoveredPlane = plane;
        if (this._renderer3d) this._renderer3d.setHoveredPlane(plane);
        this._scheduleRender();
      });
      item.addEventListener('mouseleave', () => {
        const plane = item.getAttribute('data-plane');
        if (!this._isOriginPlaneVisible(plane) && this._hoveredPlane !== plane) return;
        this._hoveredPlane = null;
        if (this._renderer3d) this._renderer3d.setHoveredPlane(null);
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
        if (save === null) return; // ESC pressed — cancel exit, stay in sketch
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

  _bindExitExtrudeButton() {
    const btn = document.getElementById('btn-exit-extrude');
    if (!btn) return;
    btn.addEventListener('click', async () => {
      if (!this._extrudeMode) return;

      const confirm = await showConfirm({
        title: 'Exit Extrude',
        message: 'Accept extrude or discard?',
        okText: 'Accept',
        cancelText: 'Discard',
      });
      if (confirm === null) return; // ESC pressed — cancel exit, stay in extrude
      if (confirm) {
        this._acceptExtrude();
      } else {
        this._cancelExtrude();
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

    // Return to Part Design mode
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
      // Restore camera orientation from before entering sketch mode
      if (this._savedOrbitState) {
        this._renderer3d.restoreOrbitState(this._savedOrbitState);
        this._syncFovSlider(this._savedOrbitState.fovDegrees != null ? this._savedOrbitState.fovDegrees : 45);
        this._savedOrbitState = null;
      }
    }

    const modeIndicator = document.getElementById('status-mode');
    modeIndicator.textContent = 'PART DESIGN';
    modeIndicator.className = 'status-mode part-mode';

    this.setActiveTool('select');
    this._update3DView();
    this._updateOperationButtons();
    this.setStatus('Sketch discarded. Returned to Part Design mode.');
    info('Discarded sketch-on-plane, returned to Part Design mode');
    this._scheduleRender();
  }

  // --- Part Mode Tool Events ---

  // --- Recording Controls ---

  _bindRecordingControls() {
    const btnRecord = document.getElementById('btn-record');
    const btnExport = document.getElementById('btn-record-export');
    const btnOpen = document.getElementById('btn-record-open');
    const btnPrev = document.getElementById('btn-play-prev');
    const btnToggle = document.getElementById('btn-play-toggle');
    const btnNext = document.getElementById('btn-play-next');
    const btnStop = document.getElementById('btn-play-stop');
    const slider = document.getElementById('play-slider');
    const stepLabel = document.getElementById('play-step-label');
    const speedInput = document.getElementById('play-speed');
    const recPreview = document.getElementById('rec-preview');

    // Playback state
    this._playbackSteps = null;
    this._playbackIndex = -1;
    this._playbackTimer = null;
    this._playbackPlaying = false;

    // Live preview: show last recorded action while recording
    this._recorder.onStep = (step) => {
      if (!recPreview) return;
      recPreview.textContent = `#${step.seq} ${step.command}`;
      recPreview.classList.add('active');
      // Flash animation
      recPreview.classList.remove('flash');
      // Force reflow so removing+re-adding 'flash' restarts the CSS animation
      void recPreview.offsetWidth;
      recPreview.classList.add('flash');
    };

    const updatePlaybackUI = () => {
      const hasRec = !!this._playbackSteps;
      const count = hasRec ? this._playbackSteps.length : 0;
      const idx = this._playbackIndex;

      btnPrev.disabled = !hasRec || idx <= 0;
      btnToggle.disabled = !hasRec;
      btnNext.disabled = !hasRec || idx >= count - 1;
      btnStop.disabled = !hasRec;
      slider.disabled = !hasRec;
      slider.max = Math.max(0, count - 1);
      slider.value = Math.max(0, idx);

      if (hasRec && idx >= 0) {
        stepLabel.textContent = `${idx + 1} / ${count}`;
      } else if (hasRec) {
        stepLabel.textContent = `0 / ${count}`;
      } else {
        stepLabel.textContent = '—';
      }

      btnToggle.textContent = this._playbackPlaying ? '⏸' : '▶';
      btnToggle.title = this._playbackPlaying ? 'Pause' : 'Play';
    };

    // Record start/stop
    if (btnRecord) {
      btnRecord.addEventListener('click', () => {
        if (this._recorder.recording) {
          this._stopRecording();
        } else {
          this._startRecording();
        }
      });
    }

    // Export
    if (btnExport) {
      btnExport.addEventListener('click', () => this._exportRecording());
    }

    // Open recording (modal)
    if (btnOpen) {
      btnOpen.addEventListener('click', () => this._openRecordingModal());
    }

    // Playback step execution
    const executeStep = (idx) => {
      if (!this._playbackSteps || idx < 0 || idx >= this._playbackSteps.length) return;
      const step = this._playbackSteps[idx];
      const cmdInput = document.getElementById('cmd-input');
      if (cmdInput) cmdInput.value = step.command;
      this.setStatus(`▶ Step ${idx + 1}/${this._playbackSteps.length}: ${step.command}`);
      try {
        this._handleCommand(step.command);
      } catch (err) {
        warn(`Playback error at step ${idx}: ${step.command}`, err);
      }
      this._playbackIndex = idx;
      updatePlaybackUI();
      // Show position indicator for spatial commands
      this._showPlaybackIndicator(step.command);
    };

    // Slider scrub
    if (slider) {
      slider.addEventListener('input', () => {
        this._stopAutoplay();
        const target = parseInt(slider.value, 10);
        // Replay from beginning up to target for consistent state
        this._replayUpTo(target);
        updatePlaybackUI();
      });
    }

    // Step prev
    if (btnPrev) {
      btnPrev.addEventListener('click', () => {
        this._stopAutoplay();
        if (this._playbackIndex > 0) {
          this._replayUpTo(this._playbackIndex - 1);
          updatePlaybackUI();
        }
      });
    }

    // Step next
    if (btnNext) {
      btnNext.addEventListener('click', () => {
        this._stopAutoplay();
        if (this._playbackSteps && this._playbackIndex < this._playbackSteps.length - 1) {
          executeStep(this._playbackIndex + 1);
        }
      });
    }

    // Play/Pause toggle
    if (btnToggle) {
      btnToggle.addEventListener('click', () => {
        if (this._playbackPlaying) {
          this._stopAutoplay();
        } else {
          this._startAutoplay(executeStep, updatePlaybackUI);
        }
        updatePlaybackUI();
      });
    }

    // Stop — reset
    if (btnStop) {
      btnStop.addEventListener('click', () => {
        this._stopAutoplay();
        this._playbackSteps = null;
        this._playbackIndex = -1;
        this.setStatus('Playback stopped.');
        const cmdInput = document.getElementById('cmd-input');
        if (cmdInput) cmdInput.value = '';
        this._hidePlaybackIndicator();
        updatePlaybackUI();
      });
    }

    this._updatePlaybackUI = updatePlaybackUI;
    this._executePlaybackStep = executeStep;

    // Wire camera events from the 3D renderer to the recorder
    if (this._renderer3d) {
      this._renderer3d.onCameraInteraction = (type, orbitState) => {
        if (!this._recorder.recording) return;
        const { theta, phi, radius, target } = orbitState;
        if (type === 'orbit_start') {
          this._recorder.orbitStart(theta, phi, radius, target);
        } else if (type === 'pan_start') {
          this._recorder.panStart(target);
        } else if (type === 'orbit_end') {
          this._recorder.orbitEnd(theta, phi, radius, target);
        } else if (type === 'zoom') {
          this._recorder.cameraSnapshot(theta, phi, radius, target);
        }
      };
    }

    updatePlaybackUI();
  }

  _startAutoplay(executeStep, updatePlaybackUI) {
    if (!this._playbackSteps) return;
    this._playbackPlaying = true;
    const speedEl = document.getElementById('play-speed');
    const speed = parseFloat(speedEl?.value) || 1;

    const advance = () => {
      if (!this._playbackPlaying || !this._playbackSteps) return;
      const nextIdx = this._playbackIndex + 1;
      if (nextIdx >= this._playbackSteps.length) {
        this._playbackPlaying = false;
        this.setStatus('Playback complete.');
        updatePlaybackUI();
        return;
      }
      executeStep(nextIdx);

      // Compute delay from timestamps if available
      let delay = 300;
      if (nextIdx + 1 < this._playbackSteps.length) {
        const dt = this._playbackSteps[nextIdx + 1].ts - this._playbackSteps[nextIdx].ts;
        delay = Math.max(50, dt / speed);
      }
      this._playbackTimer = setTimeout(advance, delay);
    };

    advance();
  }

  _stopAutoplay() {
    this._playbackPlaying = false;
    if (this._playbackTimer) {
      clearTimeout(this._playbackTimer);
      this._playbackTimer = null;
    }
  }

  /**
   * Reset application state to a clean slate for playback.
   * Destroys the current part, clears sketch state, and resets internal flags
   * so that replayed commands build from scratch.
   */
  _resetForPlayback() {
    // Exit sketch mode if active
    if (this._sketchingOnPlane) {
      this._sketchingOnPlane = false;
      document.body.classList.remove('sketch-on-plane');
    }

    // Clear sketch scene
    state.scene.clear();
    state.selectedEntities = [];

    // Reset internal state
    this._selectedFaces.clear();
    this._selectedPlane = null;
    this._hoveredPlane = null;
    this._activeSketchPlane = null;
    this._activeSketchPlaneDef = null;
    this._editingSketchFeatureId = null;
    this._lastSketchFeatureId = null;
    this._savedOrbitState = null;
    this._workspaceMode = null;
    this._expandedFolders.clear();
    this._rollbackIndex = -1;

    // Destroy the current part and create a blank slate
    this._partManager.part = null;
    this._partManager.activeFeature = null;

    // Restore initial settings from the recording if available
    const s = this._playbackInitialSettings;
    if (s) {
      if (s.fov != null && this._renderer3d) { this._renderer3d.setFOV(s.fov); this._syncFovSlider(s.fov); }
      if (s.snapEnabled != null) state.snapEnabled = s.snapEnabled;
      if (s.orthoEnabled != null) state.orthoEnabled = s.orthoEnabled;
      if (s.gridVisible != null) state.gridVisible = s.gridVisible;
      if (s.gridSize != null && s.gridSize > 0) state.gridSize = s.gridSize;
      if (s.constructionMode != null) state.constructionMode = s.constructionMode;
      if (s.autoCoincidence != null) state.autoCoincidence = s.autoCoincidence;
    }

    // Reset UI
    if (this._featurePanel) this._featurePanel.update();
    if (this._parametersPanel) this._parametersPanel.clear();
    this._showLeftFeatureParams(null);
    this._updateNodeTree();
    this._update3DView();
    this._scheduleRender();
  }

  /** Replay all steps from 0..targetIdx to get consistent state */
  _replayUpTo(targetIdx) {
    if (!this._playbackSteps) return;
    // Reset to clean state before replaying from the beginning
    this._resetForPlayback();
    for (let i = 0; i <= targetIdx && i < this._playbackSteps.length; i++) {
      try {
        this._handleCommand(this._playbackSteps[i].command);
      } catch (err) {
        // Errors are expected during state reconstruction when scrubbing —
        // e.g. selecting a face that doesn't exist yet at that point in time.
        // Log at debug level so devs can inspect but slider stays responsive.
        debug(`Replay scrub skip at step ${i}: ${err.message}`);
      }
    }
    this._playbackIndex = targetIdx;
    const step = this._playbackSteps[targetIdx];
    if (step) {
      const cmdInput = document.getElementById('cmd-input');
      if (cmdInput) cmdInput.value = step.command;
      this.setStatus(`▶ Step ${targetIdx + 1}/${this._playbackSteps.length}: ${step.command}`);
      this._showPlaybackIndicator(step.command);
    }
  }

  /** Load a recording for playback */
  async _loadRecording(recording) {
    this._stopAutoplay();
    if (recording && recording.steps && recording.steps.length > 0) {
      // Warn the user that current work will be lost
      const ok = await showConfirm({
        title: 'Load Recording',
        message: 'Loading a recording will clear the current model. All unsaved changes will be lost.\n\nContinue?',
        okText: 'Load',
        cancelText: 'Cancel',
      });
      if (!ok) return;

      this._playbackInitialSettings = recording.initialSettings || null;
      this._resetForPlayback();
      this._playbackSteps = recording.steps;
      this._playbackIndex = -1;
      this._lastRecordedSteps = recording.steps;
      this.setStatus(`Recording loaded: ${recording.steps.length} step(s). Use playback controls.`);
      info(`Recording loaded: ${recording.steps.length} steps`);
    } else {
      this.setStatus('Invalid recording data.');
    }
    if (this._updatePlaybackUI) this._updatePlaybackUI();
  }

  /**
   * Show a visual position indicator on the canvas for spatial playback commands.
   * Extracts model coordinates from the command, projects to screen, and
   * positions the indicator overlay. Hides for non-spatial commands.
   * @param {string} command - The command string being played
   */
  _showPlaybackIndicator(command) {
    const el = document.getElementById('playback-indicator');
    if (!el) return;
    const dot = el.querySelector('.playback-indicator-dot');
    const label = el.querySelector('.playback-indicator-label');

    const tokens = command.trim().split(/\s+/);
    const cmd = tokens[0];
    let screenPos = null;
    let labelText = '';

    // Extract @px py pz point annotation if present (appended by recorder for 3D actions)
    const atIdx = command.indexOf(' @');
    let atPoint = null;
    if (atIdx >= 0) {
      const atParts = command.substring(atIdx + 2).trim().split(/\s+/);
      if (atParts.length >= 3) {
        atPoint = {
          x: parseFloat(atParts[0]),
          y: parseFloat(atParts[1]),
          z: parseFloat(atParts[2]),
        };
      }
    }

    // Helper: project sketch-plane 2D coords to screen
    const sketchToScreen = (mx, my) => {
      if (this._renderer3d && this._renderer3d.hasSketchPlane()) {
        return this._renderer3d.sketchToScreen(mx, my);
      } else if (this._renderer3d) {
        return this._renderer3d.worldToScreen(mx, my, 0);
      }
      return null;
    };

    if (cmd === 'click' && tokens.length >= 3) {
      const mx = parseFloat(tokens[1]);
      const my = parseFloat(tokens[2]);
      labelText = `click (${mx.toFixed(2)}, ${my.toFixed(2)})`;
      screenPos = sketchToScreen(mx, my);
    } else if (cmd === 'draw.line' && tokens.length >= 5) {
      const x1 = parseFloat(tokens[1]), y1 = parseFloat(tokens[2]);
      const x2 = parseFloat(tokens[3]), y2 = parseFloat(tokens[4]);
      labelText = `line (${x1.toFixed(1)},${y1.toFixed(1)})→(${x2.toFixed(1)},${y2.toFixed(1)})`;
      screenPos = sketchToScreen((x1 + x2) / 2, (y1 + y2) / 2);
    } else if (cmd === 'draw.rect' && tokens.length >= 5) {
      const x1 = parseFloat(tokens[1]), y1 = parseFloat(tokens[2]);
      const x2 = parseFloat(tokens[3]), y2 = parseFloat(tokens[4]);
      labelText = `rect (${x1.toFixed(1)},${y1.toFixed(1)})→(${x2.toFixed(1)},${y2.toFixed(1)})`;
      screenPos = sketchToScreen((x1 + x2) / 2, (y1 + y2) / 2);
    } else if (cmd === 'draw.circle' && tokens.length >= 4) {
      const cx = parseFloat(tokens[1]), cy = parseFloat(tokens[2]);
      const r = parseFloat(tokens[3]);
      labelText = `circle c=(${cx.toFixed(1)},${cy.toFixed(1)}) r=${r.toFixed(1)}`;
      screenPos = sketchToScreen(cx, cy);
    } else if (atPoint && this._renderer3d) {
      // Any command with @point — use the recorded 3D click coordinates
      const p = atPoint;
      if (cmd === 'select.face') {
        labelText = `face ${tokens[1]} @(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
      } else if (cmd === 'select.plane') {
        labelText = `plane ${tokens[1]} @(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
      } else if (cmd === 'deselect.face') {
        labelText = `deselect @(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
      } else {
        labelText = `@(${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`;
      }
      screenPos = this._renderer3d.worldToScreen(p.x, p.y, p.z);
    }

    if (screenPos) {
      // Offset for the canvas container position
      const container = document.getElementById('view-3d');
      const rect = container ? container.getBoundingClientRect() : { left: 0, top: 0 };
      el.style.left = `${rect.left + screenPos.x}px`;
      el.style.top = `${rect.top + screenPos.y}px`;
      el.style.display = '';
      if (label) label.textContent = labelText;
    } else {
      el.style.display = 'none';
    }
  }

  _hidePlaybackIndicator() {
    const el = document.getElementById('playback-indicator');
    if (el) el.style.display = 'none';
  }

  _openRecordingModal() {
    const root = document.getElementById('app-modal-root');
    if (!root) return;

    root.innerHTML = `
      <div class="app-modal-backdrop" data-dismiss></div>
      <div class="app-modal" style="width:500px">
        <div class="app-modal-header">Open Recording</div>
        <div class="app-modal-body">
          <div id="rec-drop-zone" style="border:2px dashed var(--border);border-radius:6px;padding:24px;text-align:center;color:var(--text-secondary);margin-bottom:12px;cursor:pointer">
            Drop a recording JSON file here, or click to browse
            <input type="file" id="rec-file-input" accept=".json" style="display:none" />
          </div>
          <div style="color:var(--text-secondary);font-size:12px;margin-bottom:6px">Or paste raw JSON:</div>
          <textarea id="rec-json-input" rows="8" style="width:100%;background:var(--bg-dark);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;font-family:Consolas,monospace;font-size:12px;padding:8px;resize:vertical" placeholder='{ "version": 1, "steps": [...] }'></textarea>
        </div>
        <div class="app-modal-footer">
          <button class="modal-btn" data-dismiss>Cancel</button>
          <button class="modal-btn modal-btn-primary" id="rec-load-btn">Load</button>
        </div>
      </div>
    `;
    root.classList.add('open');
    root.setAttribute('aria-hidden', 'false');

    const dismiss = () => {
      root.classList.remove('open');
      root.setAttribute('aria-hidden', 'true');
      root.innerHTML = '';
    };

    root.querySelectorAll('[data-dismiss]').forEach(el => el.addEventListener('click', dismiss));

    // File input
    const dropZone = root.querySelector('#rec-drop-zone');
    const fileInput = root.querySelector('#rec-file-input');
    const jsonInput = root.querySelector('#rec-json-input');

    dropZone.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => { jsonInput.value = ev.target.result; };
        reader.readAsText(file);
      }
    });

    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = 'var(--accent)'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = 'var(--border)'; });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.style.borderColor = 'var(--border)';
      const file = e.dataTransfer.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (ev) => { jsonInput.value = ev.target.result; };
        reader.readAsText(file);
      }
    });

    // Load button
    root.querySelector('#rec-load-btn').addEventListener('click', () => {
      const text = jsonInput.value.trim();
      if (!text) return;
      try {
        const data = JSON.parse(text);
        this._loadRecording(data);
        dismiss();
      } catch (err) {
        this.setStatus('Invalid JSON: ' + err.message);
      }
    });
  }

  _startRecording() {
    this._stopAutoplay();
    this._playbackSteps = null;
    this._playbackIndex = -1;
    this._recorder.start();
    const btnRecord = document.getElementById('btn-record');
    const btnExport = document.getElementById('btn-record-export');
    const recPreview = document.getElementById('rec-preview');
    if (btnRecord) btnRecord.classList.add('recording');
    if (btnExport) btnExport.style.display = 'none';
    if (recPreview) { recPreview.textContent = ''; recPreview.classList.remove('active'); }
    // Capture initial UI settings so playback can restore them
    this._recorder.setInitialSettings({
      fov: this._renderer3d ? this._renderer3d.getFOV() : 45,
      snapEnabled: state.snapEnabled,
      orthoEnabled: state.orthoEnabled,
      gridVisible: state.gridVisible,
      gridSize: state.gridSize,
      constructionMode: state.constructionMode,
      autoCoincidence: state.autoCoincidence,
    });
    // Record initial workspace state
    if (this._workspaceMode) this._recorder.workspaceChanged(this._workspaceMode);
    // Record initial camera state
    if (this._renderer3d) {
      const orb = this._renderer3d.getOrbitState();
      this._recorder.cameraSnapshot(orb.theta, orb.phi, orb.radius, orb.target);
    }
    this.setStatus('Recording started — interact normally, then stop to export.');
    info('Interaction recording started');
    if (this._updatePlaybackUI) this._updatePlaybackUI();
  }

  _stopRecording() {
    const steps = this._recorder.stop();
    const btnRecord = document.getElementById('btn-record');
    const btnExport = document.getElementById('btn-record-export');
    if (btnRecord) btnRecord.classList.remove('recording');
    if (btnExport) btnExport.style.display = '';
    this._lastRecordedSteps = steps;
    // Auto-load for playback
    this._playbackSteps = steps;
    this._playbackIndex = -1;
    // Keep preview visible with final step count
    const recPreview = document.getElementById('rec-preview');
    if (recPreview) { recPreview.textContent = `${steps.length} step(s) recorded`; }
    this.setStatus(`Recording stopped — ${steps.length} action(s) captured. Use playback controls or export.`);
    info(`Interaction recording stopped: ${steps.length} steps`);
    if (this._updatePlaybackUI) this._updatePlaybackUI();
  }

  _exportRecording() {
    const partStats = this._gatherPartStats();
    const json = this._recorder.exportJSON(partStats);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `recording-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    this.setStatus('Recording exported.');
    info('Recording exported as JSON');
  }

  /** Collect statistics about the current part/solid for regression tracking. */
  _gatherPartStats() {
    const part = this._partManager.getPart();
    if (!part) return null;

    const features = part.getFeatures();
    const geo = part.getFinalGeometry();
    const stats = {
      featureCount: features.length,
      featureTypes: features.map(f => f.type),
    };

    if (geo && geo.geometry) {
      const geometry = geo.geometry;
      const faces = geometry.faces || [];
      stats.faceCount = faces.length;
      stats.volume = +calculateMeshVolume(geometry).toFixed(6);
      stats.surfaceArea = +calculateSurfaceArea(geometry).toFixed(6);

      const bb = calculateBoundingBox(geometry);
      stats.boundingBox = bb;
      stats.width = +(bb.max.x - bb.min.x).toFixed(6);
      stats.height = +(bb.max.y - bb.min.y).toFixed(6);
      stats.depth = +(bb.max.z - bb.min.z).toFixed(6);

      // Feature edges and paths
      const edges = geometry.edges || [];
      const paths = geometry.paths || [];
      stats.edgeCount = edges.length;
      stats.pathCount = paths.length;

      // Disconnected body detection
      const bodies = detectDisconnectedBodies(geometry);
      stats.bodyCount = bodies.bodyCount;
      stats.bodySizes = bodies.bodySizes;

      // Wall thickness analysis
      const wt = calculateWallThickness(geometry);
      stats.minWallThickness = +wt.minThickness.toFixed(6);
      stats.maxWallThickness = +wt.maxThickness.toFixed(6);
      stats.invertedFaceCount = countInvertedFaces(geometry);
    }

    return stats;
  }

  async _playbackRecording(stepDelay = 300) {
    if (!this._playbackSteps || this._playbackSteps.length === 0) {
      if (this._lastRecordedSteps) {
        this._playbackSteps = this._lastRecordedSteps;
        this._playbackIndex = -1;
      } else {
        this.setStatus('No recording to play back.');
        return;
      }
    }

    // Use initial settings from the recorder if not already set from a loaded file
    if (!this._playbackInitialSettings && this._recorder._initialSettings) {
      this._playbackInitialSettings = this._recorder._initialSettings;
    }

    // Warn the user that current work will be lost
    const ok = await showConfirm({
      title: 'Play Recording',
      message: 'Playing back a recording will clear the current model. All unsaved changes will be lost.\n\nContinue?',
      okText: 'Play',
      cancelText: 'Cancel',
    });
    if (!ok) return;

    this._resetForPlayback();
    this._playbackIndex = -1;
    if (this._updatePlaybackUI) this._updatePlaybackUI();
    // Start autoplay via the playback controls
    if (this._executePlaybackStep && this._updatePlaybackUI) {
      this._startAutoplay(this._executePlaybackStep, this._updatePlaybackUI);
    }
  }

  _bindPartToolEvents() {
    const btnCreatePlane = document.getElementById('btn-create-plane');
    const btnSketchOnPlane = document.getElementById('btn-sketch-on-plane');
    const btnExtrudeCut = document.getElementById('btn-extrude-cut');

    if (btnCreatePlane) {
      btnCreatePlane.addEventListener('click', () => {
        this._startCreatePlane();
      });
    }

    if (btnSketchOnPlane) {
      btnSketchOnPlane.addEventListener('click', () => {
        // If a face is selected, use its plane
        const firstFace = this._selectedFaces.size > 0 ? this._selectedFaces.values().next().value : null;
        if (firstFace && firstFace.face) {
          this._startSketchOnFace(firstFace);
        } else {
          this._startSketchOnPlane();
        }
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

    // If no plane specified and none pre-selected, enter awaiting mode
    const plane = planeName || this._selectedPlane;
    if (!plane) {
      this._enterAwaitSketchPlane();
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

    const part = this._partManager.getPart();
    if (part) part.setActiveSketch(null);

    // Add sketch-on-plane body class to control UI visibility
    document.body.classList.add('sketch-on-plane');

    // Show Exit Sketch button
    const exitBtn = document.getElementById('btn-exit-sketch');
    if (exitBtn) exitBtn.style.display = 'flex';

    if (this._renderer3d) {
      // Save camera state before reorienting so we can restore on exit
      this._savedOrbitState = this._renderer3d.saveOrbitState();
      // Orient camera perpendicular to the selected plane
      this._renderer3d.orientToPlane(plane);
      // Lock to orthographic for sketch precision
      this._renderer3d.setFOV(0);
      this._syncFovSlider(0);
      // Stay in 3D mode so the mesh remains visible
      this._renderer3d.setMode('3d');
      this._renderer3d.setVisible(true);
      // Tell renderer which sketch plane we're on (for colored reference axes)
      this._renderer3d._sketchPlane = plane;
      // Store plane definition for screen projection of sketch entities
      this._renderer3d._sketchPlaneDef = this._activeSketchPlaneDef;
    }

    // Deselect everything now that we've entered sketch mode
    this._selectedPlane = null;
    this._selectedFaces.clear();
    if (this._renderer3d) {
      this._renderer3d.setSelectedPlane(null);
      this._renderer3d.clearFaceSelection();
      this._renderer3d.setHoveredFace(-1);
      this._renderer3d.clearEdgeSelection();
    }

    const modeIndicator = document.getElementById('status-mode');
    modeIndicator.textContent = `SKETCH ON ${plane}`;
    modeIndicator.className = 'status-mode sketch-mode';

    this.setActiveTool('select');
    this.setStatus(`Sketching on ${plane} plane. Draw your profile, then Exit Sketch to extrude.`);
    this._recorder.sketchStarted(plane, null);
    info(`Entered sketch-on-plane mode (${plane} plane)`);
    this._scheduleRender();
  }

  /**
   * Start sketching on a selected 3D face. Derives the plane from the face normal.
   * @param {Object} faceHit - Face hit from pickFace() with face and point
   */
  /**
   * Enter "awaiting sketch plane" mode: highlight the button and wait for
   * the user to click a flat face or reference plane. ESC / X cancels.
   */
  _enterAwaitSketchPlane() {
    if (this._awaitingSketchPlane) return; // already waiting
    this._awaitingSketchPlane = true;
    const btn = document.getElementById('btn-sketch-on-plane');
    if (btn) btn.classList.add('awaiting');
    this.setStatus('Select a flat face or reference plane to start sketching. Press Escape to cancel.');
  }

  _cancelAwaitSketchPlane() {
    if (!this._awaitingSketchPlane) return;
    this._awaitingSketchPlane = false;
    const btn = document.getElementById('btn-sketch-on-plane');
    if (btn) btn.classList.remove('awaiting');
    this.setStatus('Sketch plane selection cancelled.');
  }

  _startSketchOnFace(faceHit) {
    if (this._workspaceMode !== 'part') return;
    if (!faceHit || !faceHit.face) return;

    // Block sketching on curved (non-planar) surfaces
    if (faceHit.face.isCurved) {
      info('Cannot create sketch on a curved surface');
      return;
    }

    const planeDef = this._getPlaneFromFace(faceHit);
    if (!planeDef) return;

    // Clear the 2D scene so each sketch starts fresh
    state.scene.clear();
    state.selectedEntities = [];

    // Store the face-derived plane definition for raycasting
    this._activeSketchPlaneDef = planeDef;

    // Orient camera perpendicular to the face normal
    if (this._renderer3d) {
      // Save camera state before reorienting so we can restore on exit
      this._savedOrbitState = this._renderer3d.saveOrbitState();
      this._renderer3d.orientToPlaneNormal(faceHit.face.normal, faceHit.point);
      // Lock to orthographic for sketch precision
      this._renderer3d.setFOV(0);
      this._syncFovSlider(0);
    }

    // Stay in 3D mode but enable sketch-on-plane
    this._sketchingOnPlane = true;
    this._activeSketchPlane = 'FACE';
    this._3dMode = true;

    const part = this._partManager.getPart();
    if (part) part.setActiveSketch(null);

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

    // Clear all selections
    this._selectedFaces.clear();
    this._selectedPlane = null;
    if (this._renderer3d) {
      this._renderer3d.clearFaceSelection();
      this._renderer3d.setHoveredFace(-1);
      this._renderer3d.setSelectedPlane(null);
      this._renderer3d.clearEdgeSelection();
    }

    const modeIndicator = document.getElementById('status-mode');
    modeIndicator.textContent = 'SKETCH ON FACE';
    modeIndicator.className = 'status-mode sketch-mode';

    this.setActiveTool('select');
    this.setStatus('Sketching on face. Draw your profile, then Exit Sketch to extrude.');
    this._recorder.sketchStarted('FACE', planeDef);
    info('Entered sketch-on-face mode');
    this._scheduleRender();
  }

  /**
   * Derive a plane definition from a face hit result.
   * @param {Object} faceHit - Result from pickFace()
   * @returns {Object} Plane definition with origin, normal, xAxis, yAxis
   */
  /**
   * Orient the camera perpendicular to the active sketch plane, selected face, or selected plane.
   */
  _orientToNormalView() {
    if (!this._renderer3d) return;

    // 1. Active sketch plane
    if (this._sketchingOnPlane && this._activeSketchPlaneDef) {
      this._renderer3d.orientToPlaneNormal(this._activeSketchPlaneDef.normal, this._activeSketchPlaneDef.origin);
      this._scheduleRender();
      return;
    }
    if (this._sketchingOnPlane && this._activeSketchPlane && this._activeSketchPlane !== 'FACE') {
      this._renderer3d.orientToPlane(this._activeSketchPlane);
      this._scheduleRender();
      return;
    }

    // 2. Selected face
    if (this._selectedFaces.size > 0) {
      const firstFace = this._selectedFaces.values().next().value;
      if (firstFace && firstFace.face && firstFace.face.normal) {
        this._renderer3d.orientToPlaneNormal(firstFace.face.normal, firstFace.point);
        this._scheduleRender();
        return;
      }
    }

    // 3. Selected reference plane
    if (this._selectedPlane) {
      this._renderer3d.orientToPlane(this._selectedPlane);
      this._scheduleRender();
      return;
    }

    this.setStatus('Select a face or plane first, or enter a sketch.');
  }

  _getPlaneFromFace(faceHit) {
    const normal = faceHit.face.normal;
    const origin = faceHit.point;

    const absNx = Math.abs(normal.x), absNy = Math.abs(normal.y), absNz = Math.abs(normal.z);

    // Choose xAxis reference to match standard plane conventions:
    //   Z-dominant normal → xAxis along X, yAxis along Y  (like XY plane)
    //   Y-dominant normal → xAxis along X, yAxis along Z  (like XZ plane)
    //   X-dominant normal → xAxis along Y, yAxis along Z  (like YZ plane)
    let xRef, yRef;
    if (absNz >= absNx && absNz >= absNy) {
      xRef = { x: 1, y: 0, z: 0 };
      yRef = { x: 0, y: 1, z: 0 };
    } else if (absNy >= absNx) {
      xRef = { x: 1, y: 0, z: 0 };
      yRef = { x: 0, y: 0, z: 1 };
    } else {
      xRef = { x: 0, y: 1, z: 0 };
      yRef = { x: 0, y: 0, z: 1 };
    }

    // Project xRef onto the plane (remove component along normal)
    const d = xRef.x * normal.x + xRef.y * normal.y + xRef.z * normal.z;
    const xAxis = {
      x: xRef.x - d * normal.x,
      y: xRef.y - d * normal.y,
      z: xRef.z - d * normal.z,
    };
    const xLen = Math.sqrt(xAxis.x * xAxis.x + xAxis.y * xAxis.y + xAxis.z * xAxis.z);
    if (xLen < 1e-10) return null;
    xAxis.x /= xLen; xAxis.y /= xLen; xAxis.z /= xLen;

    // yAxis = normal × xAxis (perpendicular to both)
    const yAxis = {
      x: normal.y * xAxis.z - normal.z * xAxis.y,
      y: normal.z * xAxis.x - normal.x * xAxis.z,
      z: normal.x * xAxis.y - normal.y * xAxis.x,
    };
    const yLen = Math.sqrt(yAxis.x * yAxis.x + yAxis.y * yAxis.y + yAxis.z * yAxis.z);
    if (yLen < 1e-10) return null;
    yAxis.x /= yLen; yAxis.y /= yLen; yAxis.z /= yLen;

    // Flip yAxis if it doesn't align with the expected positive direction
    const yDot = yAxis.x * yRef.x + yAxis.y * yRef.y + yAxis.z * yRef.z;
    if (yDot < 0) {
      xAxis.x = -xAxis.x; xAxis.y = -xAxis.y; xAxis.z = -xAxis.z;
      yAxis.x = -yAxis.x; yAxis.y = -yAxis.y; yAxis.z = -yAxis.z;
    }

    return { origin, normal, xAxis, yAxis };
  }

  /**
   * Compute the outer boundary of a group of coplanar polygon faces.
   * Edges used by exactly 1 face in the group are boundary edges;
   * they are chained into a closed loop and the loop vertices are returned.
   * @param {Array<Array<{x,y,z}>>} faceVertArrays - Array of vertex arrays (one per face)
   * @returns {Array<{x,y,z}>} Ordered boundary vertices
   */
  _computeGroupBoundary(faceVertArrays) {
    const prec = 5;
    const vk = (v) => `${v.x.toFixed(prec)},${v.y.toFixed(prec)},${v.z.toFixed(prec)}`;
    const ek = (a, b) => { const ka = vk(a), kb = vk(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };

    // Count how many faces use each edge
    const edgeCount = new Map();
    const edgeVerts = new Map(); // edgeKey → {a, b}
    for (const verts of faceVertArrays) {
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        const key = ek(a, b);
        edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
        if (!edgeVerts.has(key)) edgeVerts.set(key, { a, b });
      }
    }

    // Boundary edges are those used by exactly 1 face
    const adj = new Map();
    for (const [key, count] of edgeCount) {
      if (count !== 1) continue;
      const { a, b } = edgeVerts.get(key);
      const ka = vk(a), kb = vk(b);
      if (!adj.has(ka)) adj.set(ka, []);
      if (!adj.has(kb)) adj.set(kb, []);
      adj.get(ka).push({ key: kb, vertex: b });
      adj.get(kb).push({ key: ka, vertex: a });
    }

    // Walk the boundary
    const visited = new Set();
    const loop = [];
    const startKey = adj.keys().next().value;
    if (!startKey) return [];
    let currentKey = startKey;
    let safety = adj.size + 1;
    while (!visited.has(currentKey) && safety-- > 0) {
      visited.add(currentKey);
      const neighbors = adj.get(currentKey);
      if (!neighbors) break;
      let next = null;
      for (const n of neighbors) {
        if (!visited.has(n.key)) { next = n; break; }
      }
      if (!next) break;
      loop.push(next.vertex);
      currentKey = next.key;
    }
    return loop;
  }

  async _finishSketchOnPlane() {
    if (!this._sketchingOnPlane) return;

    // Clear the active sketch on the part
    const part = this._partManager.getPart();
    if (part) part.setActiveSketch(null);

    // If editing an existing sketch, update it in-place
    if (this._editingSketchFeatureId && part) {
      const sketchFeature = part.getFeature(this._editingSketchFeatureId);
      if (sketchFeature && sketchFeature.type === 'sketch' && state.entities.length > 0) {
        // Rebuild the sketch from the current 2D scene
        const { Sketch } = await import('./cad/Sketch.js');
        const sketch = new Sketch();
        sketch.name = sketchFeature.sketch.name;
        for (const seg of state.scene.segments) {
          const s = seg.p1 || seg.start;
          const e = seg.p2 || seg.end;
          if (s && e) sketch.addSegment(s.x, s.y, e.x, e.y);
        }
        for (const circle of state.scene.circles) {
          sketch.addCircle(circle.center.x, circle.center.y, circle.radius);
        }
        sketchFeature.sketch = sketch;
        sketchFeature.modified = new Date();
        // Recalculate the feature tree from this sketch forward
        if (part.featureTree) {
          part.featureTree.recalculateFrom(this._editingSketchFeatureId);
        }
        info(`Updated sketch feature: ${this._editingSketchFeatureId}`);
      }
      this._editingSketchFeatureId = null;
    } else {
      // Add the current 2D scene as a NEW sketch feature on the active plane
      if (state.entities.length > 0) {
        if (this._activeSketchPlane === 'FACE' && this._activeSketchPlaneDef) {
          this._addSketchToPartWithPlane(this._activeSketchPlaneDef);
        } else {
          this._addSketchToPart(this._activeSketchPlane || 'XY');
        }
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
      // Restore camera orientation from before entering sketch mode
      if (this._savedOrbitState) {
        this._renderer3d.restoreOrbitState(this._savedOrbitState);
        this._syncFovSlider(this._savedOrbitState.fovDegrees != null ? this._savedOrbitState.fovDegrees : 45);
        this._savedOrbitState = null;
      }
    }

    const modeIndicator = document.getElementById('status-mode');
    modeIndicator.textContent = 'PART DESIGN';
    modeIndicator.className = 'status-mode part-mode';

    this.setActiveTool('select');
    this._update3DView();
    this._updateOperationButtons();
    this.setStatus('Returned to Part Design mode.');
    this._recorder.sketchFinished(this._lastSketchFeatureId, 0);
    info('Finished sketch-on-plane, returned to Part Design mode');
    this._scheduleRender();
  }

  /**
   * Enter edit mode for an existing sketch feature.
   * Loads the sketch geometry back into the 2D scene, enters sketch-on-plane
   * mode, and marks the sketch for in-place update on exit.
   */
  _editExistingSketch(sketchFeature) {
    if (this._sketchingOnPlane) return;
    if (!sketchFeature || sketchFeature.type !== 'sketch') return;

    const sketch = sketchFeature.sketch;
    if (!sketch) return;

    // Clear the 2D scene and load sketch geometry into it
    state.scene.clear();
    state.selectedEntities = [];

    for (const seg of sketch.segments) {
      state.scene.addSegment(seg.p1.x, seg.p1.y, seg.p2.x, seg.p2.y);
    }
    for (const circle of sketch.circles) {
      state.scene.addCircle(circle.center.x, circle.center.y, circle.radius);
    }

    // Determine plane name from the sketch feature's plane
    const plane = sketchFeature.plane;
    let planeName = 'FACE';
    if (plane) {
      // Check if it matches a standard plane
      const n = plane.normal;
      if (n && Math.abs(n.z) > 0.99 && Math.abs(n.x) < 0.01 && Math.abs(n.y) < 0.01) planeName = 'XY';
      else if (n && Math.abs(n.y) > 0.99 && Math.abs(n.x) < 0.01 && Math.abs(n.z) < 0.01) planeName = 'XZ';
      else if (n && Math.abs(n.x) > 0.99 && Math.abs(n.y) < 0.01 && Math.abs(n.z) < 0.01) planeName = 'YZ';
    }

    // Track that we're editing an existing sketch (not creating a new one)
    this._editingSketchFeatureId = sketchFeature.id;
    this._lastSketchFeatureId = sketchFeature.id;

    const part = this._partManager.getPart();
    if (part) part.setActiveSketch(sketchFeature.id);

    // Enter sketch-on-plane mode
    this._sketchingOnPlane = true;
    this._activeSketchPlane = planeName;
    this._activeSketchPlaneDef = plane;
    this._3dMode = true;

    document.body.classList.add('sketch-on-plane');
    const exitBtn = document.getElementById('btn-exit-sketch');
    if (exitBtn) exitBtn.style.display = 'flex';

    if (this._renderer3d) {
      this._savedOrbitState = this._renderer3d.saveOrbitState();
      if (planeName !== 'FACE') {
        this._renderer3d.orientToPlane(planeName);
      }
      // Lock to orthographic for sketch precision
      this._renderer3d.setFOV(0);
      this._syncFovSlider(0);
      this._renderer3d.setMode('3d');
      this._renderer3d.setVisible(true);
      this._renderer3d._sketchPlane = planeName;
      this._renderer3d._sketchPlaneDef = plane;
    }

    this._selectedPlane = null;
    if (this._renderer3d) this._renderer3d.setSelectedPlane(null);

    const modeIndicator = document.getElementById('status-mode');
    modeIndicator.textContent = `EDIT SKETCH: ${sketchFeature.name}`;
    modeIndicator.className = 'status-mode sketch-mode';

    this.setActiveTool('select');
    this.setStatus(`Editing ${sketchFeature.name}. Modify, then Exit Sketch to apply changes.`);
    info(`Entered edit mode for sketch: ${sketchFeature.id}`);
    this._scheduleRender();
  }

  _getPreferredSketchFeatureId() {
    const features = this._partManager ? this._partManager.getFeatures() : [];
    const activeFeature = this._partManager ? this._partManager.getActiveFeature() : null;
    const selectedFeatureId =
      (this._featurePanel && this._featurePanel.selectedFeatureId) ||
      (activeFeature ? activeFeature.id : null) ||
      (this._renderer3d ? this._renderer3d._selectedFeatureId : null) ||
      null;

    if (selectedFeatureId) {
      const selectedFeature = features.find((feature) => feature.id === selectedFeatureId);
      if (selectedFeature && selectedFeature.type === 'sketch') {
        return selectedFeature.id;
      }
    }

    return this._lastSketchFeatureId || null;
  }

  async _startExtrude(isCut = false) {
    if (this._workspaceMode !== 'part') {
      this.setStatus('Extrude is only available in Part workspace.');
      return;
    }

    // If already in extrude mode, ignore
    if (this._extrudeMode) return;

    // If a face is selected but no sketch was created for it, auto-create
    // a new sketch from the face outline instead of reusing an old sketch.
    const firstFace = this._selectedFaces.size > 0 ? this._selectedFaces.values().next().value : null;
    if (firstFace && firstFace.face && !this._lastSketchFeatureId) {
      const face = firstFace.face;
      if (face.isCurved) {
        this.setStatus('Cannot extrude from a curved surface. Select a flat face.');
        return;
      }
      const planeDef = this._getPlaneFromFace(firstFace);
      if (planeDef) {
        let allFaceVerts = [];
        const faceGroup = face.faceGroup;
        const allMeshFaces = this._renderer3d ? this._renderer3d.getAllFaces() : null;
        if (faceGroup != null && allMeshFaces) {
          const groupFaces = allMeshFaces.filter(f => f.faceGroup === faceGroup);
          for (const gf of groupFaces) {
            allFaceVerts.push(gf.vertices || []);
          }
        } else {
          allFaceVerts.push(face.vertices || []);
        }

        const faceVerts = allFaceVerts.length === 1
          ? allFaceVerts[0]
          : this._computeGroupBoundary(allFaceVerts);

        if (faceVerts.length >= 3) {
          const { Sketch } = await import('./cad/Sketch.js');
          const sketch = new Sketch();
          sketch.name = `Sketch ${this._partManager.getFeatures().filter(f => f.type === 'sketch').length + 1}`;
          const origin = planeDef.origin;
          const xAxis = planeDef.xAxis;
          const yAxis = planeDef.yAxis;
          const proj2D = faceVerts.map(v => ({
            x: (v.x - origin.x) * xAxis.x + (v.y - origin.y) * xAxis.y + (v.z - origin.z) * xAxis.z,
            y: (v.x - origin.x) * yAxis.x + (v.y - origin.y) * yAxis.y + (v.z - origin.z) * yAxis.z,
          }));
          for (let i = 0; i < proj2D.length; i++) {
            const a = proj2D[i];
            const b = proj2D[(i + 1) % proj2D.length];
            sketch.addSegment(a.x, a.y, b.x, b.y);
          }
          const part = this._partManager.getPart();
          if (part) {
            const sketchFeature = part.addSketch(sketch, planeDef);
            this._lastSketchFeatureId = sketchFeature.id;
          }
        }
      }
      this._selectedFaces.clear();
      if (this._renderer3d) this._renderer3d.clearFaceSelection();
    }

    // Clear face selection
    if (this._selectedFaces.size > 0) {
      this._selectedFaces.clear();
      if (this._renderer3d) this._renderer3d.clearFaceSelection();
    }

    const opName = isCut ? 'Extrude Cut' : 'Extrude';
    const sketchFeatureId = this._getPreferredSketchFeatureId();

    // Enter extrude mode
    this._extrudeMode = {
      isCut,
      sketchFeatureId,
      distance: 10,
      direction: isCut ? -1 : 1,
      symmetric: false,
      operation: isCut ? 'subtract' : (this._partManager.getFeatures().some(f => f.type === 'extrude' || f.type === 'extrude-cut' || f.type === 'revolve') ? 'add' : 'new'),
      extrudeType: 'distance',
      taper: false,
      taperAngle: 5,
      taperInward: true,
    };

    // Show Exit Extrude button
    const exitBtn = document.getElementById('btn-exit-extrude');
    if (exitBtn) exitBtn.style.display = 'flex';

    // Highlight the extrude button
    const btnExtrude = document.getElementById(isCut ? 'btn-extrude-cut' : 'btn-extrude');
    if (btnExtrude) btnExtrude.classList.add('active');

    // Update left panel with extrude params
    this._showExtrudeUI();

    // Show initial ghost preview
    this._updateExtrudePreview();

    this.setStatus(`${opName}: Adjust parameters, then accept or cancel.`);
    info(`Entered ${opName.toLowerCase()} mode`);
  }

  /**
   * Enter extrude edit mode for an existing feature — shows ghost preview, handle, and full edit UI.
   */
  _editExtrude(feature) {
    if (!feature || (feature.type !== 'extrude' && feature.type !== 'extrude-cut')) return;
    if (this._extrudeMode) return; // already in extrude mode

    const isCut = feature.type === 'extrude-cut';

    // Save original values for cancel/restore
    this._extrudeMode = {
      isCut,
      editingFeatureId: feature.id,
      editOriginal: {
        distance: feature.distance,
        direction: feature.direction,
        symmetric: feature.symmetric,
        operation: feature.operation,
        extrudeType: feature.extrudeType || 'distance',
        taper: feature.taper || false,
        taperAngle: feature.taperAngle != null ? feature.taperAngle : 5,
        taperInward: feature.taperInward != null ? feature.taperInward : true,
      },
      sketchFeatureId: feature.sketchFeatureId,
      distance: feature.distance,
      direction: feature.direction,
      symmetric: feature.symmetric,
      operation: feature.operation,
      extrudeType: feature.extrudeType || 'distance',
      taper: feature.taper || false,
      taperAngle: feature.taperAngle != null ? feature.taperAngle : 5,
      taperInward: feature.taperInward != null ? feature.taperInward : true,
    };

    // Show Exit Extrude button
    const exitBtn = document.getElementById('btn-exit-extrude');
    if (exitBtn) exitBtn.style.display = 'flex';

    // Highlight the extrude button
    const btnId = isCut ? 'btn-extrude-cut' : 'btn-extrude';
    const btnExtrude = document.getElementById(btnId);
    if (btnExtrude) btnExtrude.classList.add('active');

    this._showExtrudeUI();
    this._updateExtrudePreview();
    this._updateOperationButtons();

    const opName = isCut ? 'Extrude Cut' : 'Extrude';
    this.setStatus(`Editing ${opName}: Adjust parameters, then accept or cancel.`);
    info(`Editing ${opName.toLowerCase()} feature: ${feature.id}`);
  }

  /**
   * Build the left panel UI for extrude mode with live parameter editing.
   */
  _showExtrudeUI() {
    const container = document.getElementById('left-feature-params-content');
    if (!container || !this._extrudeMode) return;
    container.innerHTML = '';

    const em = this._extrudeMode;
    const baseName = em.isCut ? 'Extrude Cut' : 'Extrude';
    const opName = em.editingFeatureId ? `Edit ${baseName}` : baseName;

    // Header
    const header = document.createElement('div');
    header.className = 'parameter-row';
    header.innerHTML = `<label class="parameter-label" style="font-weight:600">${opName}</label>`;
    container.appendChild(header);

    // Sketch selection
    const features = this._partManager ? this._partManager.getFeatures() : [];
    const sketches = features.filter(f => f.type === 'sketch');
    const sketchOpts = sketches.map(s => ({ value: s.id, label: s.name }));
    if (sketchOpts.length === 0) {
      sketchOpts.push({ value: '', label: '(no sketches)' });
    }
    container.appendChild(this._createParamRow('Sketch', 'select', em.sketchFeatureId || '', (v) => {
      em.sketchFeatureId = v || null;
      this._updateExtrudePreview();
    }, sketchOpts));

    // Extrude type
    const typeOpts = [
      { value: 'distance', label: 'Distance' },
      { value: 'throughAll', label: 'Through All' },
      { value: 'upToFace', label: 'Up to Face' },
    ];
    container.appendChild(this._createParamRow('Type', 'select', em.extrudeType, (v) => {
      em.extrudeType = v;
      this._showExtrudeUI();
      this._updateExtrudePreview();
    }, typeOpts));

    // Distance (only for 'distance' type)
    if (em.extrudeType === 'distance') {
      container.appendChild(this._createParamRow('Distance', 'number', em.distance, (v) => {
        const parsed = parseFloat(v);
        if (!isNaN(parsed) && parsed > 0) {
          em.distance = parsed;
          this._updateExtrudePreview();
        }
      }));
    }

    // Up to face notice
    if (em.extrudeType === 'upToFace') {
      const notice = document.createElement('div');
      notice.className = 'parameter-row';
      notice.innerHTML = '<label class="parameter-label" style="color:#e8a040;font-size:11px">Click a face in the 3D view to set target</label>';
      container.appendChild(notice);
    }

    // Direction
    container.appendChild(this._createParamRow('Direction', 'select', em.direction, (v) => {
      em.direction = parseInt(v, 10);
      this._updateExtrudePreview();
    }, [{ value: '1', label: 'Normal' }, { value: '-1', label: 'Reverse' }]));

    // Operation
    container.appendChild(this._createParamRow('Operation', 'select', em.operation, (v) => {
      em.operation = v;
      this._updateExtrudePreview();
    }, [
      { value: 'new', label: 'New Body' },
      { value: 'add', label: 'Add (Union)' },
      { value: 'subtract', label: 'Subtract (Cut)' },
      { value: 'intersect', label: 'Intersect' },
    ]));

    // Symmetric
    container.appendChild(this._createParamRow('Symmetric', 'checkbox', em.symmetric, (v) => {
      em.symmetric = v;
      this._updateExtrudePreview();
    }));

    // Taper toggle
    container.appendChild(this._createParamRow('Taper', 'checkbox', em.taper, (v) => {
      em.taper = v;
      this._showExtrudeUI();
      this._updateExtrudePreview();
    }));

    // Taper options (only when taper enabled)
    if (em.taper) {
      container.appendChild(this._createParamRow('Taper Angle (°)', 'number', em.taperAngle, (v) => {
        const parsed = parseFloat(v);
        if (!isNaN(parsed) && parsed > 0 && parsed < 89) {
          em.taperAngle = parsed;
          this._updateExtrudePreview();
        }
      }));
      container.appendChild(this._createParamRow('Taper Dir', 'select', em.taperInward ? 'in' : 'out', (v) => {
        em.taperInward = v === 'in';
        this._updateExtrudePreview();
      }, [{ value: 'in', label: 'Inward' }, { value: 'out', label: 'Outward' }]));
    }

    // Accept / Cancel buttons
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:6px;margin-top:12px;padding:0 2px';

    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept';
    acceptBtn.className = 'parameter-input';
    acceptBtn.style.cssText = 'flex:1;padding:6px;cursor:pointer;background:rgba(60,180,80,0.9);color:#fff;border:1px solid rgba(80,200,100,0.9);border-radius:4px;font-weight:600';
    acceptBtn.addEventListener('click', () => this._acceptExtrude());

    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'parameter-input';
    cancelBtn.style.cssText = 'flex:1;padding:6px;cursor:pointer;background:rgba(180,60,60,0.9);color:#fff;border:1px solid rgba(200,80,80,0.9);border-radius:4px;font-weight:600';
    cancelBtn.addEventListener('click', () => this._cancelExtrude());

    btnRow.appendChild(acceptBtn);
    btnRow.appendChild(cancelBtn);
    container.appendChild(btnRow);
  }

  /**
   * Compute and display ghost preview for the current extrude mode parameters.
   */
  async _updateExtrudePreview() {
    if (!this._extrudeMode || !this._renderer3d) return;

    const em = this._extrudeMode;
    if (!em.sketchFeatureId || (em.extrudeType === 'distance' && em.distance <= 0)) {
      this._renderer3d.clearGhostPreview();
      this._renderer3d.clearExtrudeArrow();
      this._extrudeHandleInfo = null;
      this._scheduleRender();
      return;
    }

    try {
      const part = this._partManager.getPart();
      if (!part) return;

      const sketchFeature = part.getFeature(em.sketchFeatureId);
      if (!sketchFeature || sketchFeature.type !== 'sketch') {
        this._renderer3d.clearGhostPreview();
        this._renderer3d.clearExtrudeArrow();
        this._extrudeHandleInfo = null;
        this._scheduleRender();
        return;
      }

      // Execute sketch to get profiles
      const sketchResult = sketchFeature.execute({ results: {}, tree: part.featureTree });
      if (!sketchResult || !sketchResult.profiles || sketchResult.profiles.length === 0) {
        this._renderer3d.clearGhostPreview();
        this._renderer3d.clearExtrudeArrow();
        this._extrudeHandleInfo = null;
        this._scheduleRender();
        return;
      }

      // Use a temporary ExtrudeFeature to generate geometry
      const { ExtrudeFeature } = await import('./cad/ExtrudeFeature.js');
      const tempExtrude = new ExtrudeFeature('_preview', em.sketchFeatureId, em.distance);
      tempExtrude.direction = em.direction;
      tempExtrude.symmetric = em.symmetric;
      tempExtrude.extrudeType = em.extrudeType;
      tempExtrude.taper = em.taper;
      tempExtrude.taperAngle = em.taperAngle;
      tempExtrude.taperInward = em.taperInward;

      const geometry = tempExtrude.generateGeometry(sketchResult.profiles, sketchResult.plane);
      this._renderer3d.setGhostPreview(geometry);

      // Compute extrude handle position (centroid of first profile)
      const profPts = sketchResult.profiles[0].points;
      let hcx = 0, hcy = 0;
      for (const p of profPts) { hcx += p.x; hcy += p.y; }
      hcx /= profPts.length; hcy /= profPts.length;
      const pln = sketchResult.plane;
      const handleOrigin = {
        x: pln.origin.x + hcx * pln.xAxis.x + hcy * pln.yAxis.x,
        y: pln.origin.y + hcx * pln.xAxis.y + hcy * pln.yAxis.y,
        z: pln.origin.z + hcx * pln.xAxis.z + hcy * pln.yAxis.z,
      };
      const ds = em.direction;
      const arrowDist = em.extrudeType === 'throughAll' ? 30 : em.distance;
      const handleTip = {
        x: handleOrigin.x + pln.normal.x * arrowDist * ds,
        y: handleOrigin.y + pln.normal.y * arrowDist * ds,
        z: handleOrigin.z + pln.normal.z * arrowDist * ds,
      };
      if (em.extrudeType === 'throughAll') {
        this._extrudeHandleInfo = null;
        this._renderer3d.clearExtrudeArrow();
      } else {
        this._extrudeHandleInfo = {
          origin: handleOrigin, tip: handleTip,
          dir: { x: pln.normal.x * ds, y: pln.normal.y * ds, z: pln.normal.z * ds },
        };
        this._renderer3d.setExtrudeArrow(handleOrigin, handleTip);
      }
      this._scheduleRender();
    } catch (err) {
      console.warn('Extrude preview failed:', err);
      this._renderer3d.clearGhostPreview();
      this._renderer3d.clearExtrudeArrow();
      this._extrudeHandleInfo = null;
      this._scheduleRender();
    }
  }

  /**
   * Accept the extrude mode — create the actual feature.
   */
  _acceptExtrude() {
    if (!this._extrudeMode) return;

    const em = this._extrudeMode;

    if (!em.sketchFeatureId) {
      this.setStatus('Select a sketch before accepting.');
      return;
    }
    if (em.distance <= 0 && em.extrudeType === 'distance') {
      this.setStatus('Distance must be positive.');
      return;
    }

    const opName = em.isCut ? 'Extrude Cut' : 'Extrude';

    if (em.editingFeatureId) {
      // Editing existing feature — apply changes via modifyFeature
      this._partManager.modifyFeature(em.editingFeatureId, (f) => {
        f.setDistance(em.distance);
        f.direction = em.direction;
        f.symmetric = em.symmetric;
        f.operation = em.operation;
        f.extrudeType = em.extrudeType;
        f.taper = em.taper;
        f.taperAngle = em.taperAngle;
        f.taperInward = em.taperInward;
      });

      this._exitExtrudeMode();

      this._deselectAll();
      this._featurePanel.update();
      this._updateNodeTree();
      this._update3DView();
      this._updateOperationButtons();

      this.setStatus(`${opName} updated: ${em.distance} units`);
      this._recorder.featureModified(em.editingFeatureId, 'distance', em.distance);
      info(`Updated ${opName.toLowerCase()} feature: ${em.editingFeatureId}`);
    } else {
      // Creating a new feature
      const options = {
        operation: em.operation,
        direction: em.direction,
        symmetric: em.symmetric,
        extrudeType: em.extrudeType,
        taper: em.taper,
        taperAngle: em.taperAngle,
        taperInward: em.taperInward,
      };

      const feature = em.isCut
        ? this._partManager.extrudeCut(em.sketchFeatureId, em.distance, options)
        : this._partManager.extrude(em.sketchFeatureId, em.distance, options);

      this._exitExtrudeMode();

      this._deselectAll();
      this._featurePanel.update();
      this._updateNodeTree();
      this._update3DView();
      this._updateOperationButtons();

      this.setStatus(`${opName}: ${em.distance} units`);
      this._recorder.extrudeCreated(feature ? feature.id : null, em.distance, em.isCut);
      info(`Created ${opName.toLowerCase()} feature: ${feature ? feature.id : 'failed'}`);
    }
  }

  /**
   * Cancel the extrude mode — discard without creating a feature.
   */
  _cancelExtrude() {
    if (!this._extrudeMode) return;

    // If editing, restore original values
    if (this._extrudeMode.editingFeatureId && this._extrudeMode.editOriginal) {
      const orig = this._extrudeMode.editOriginal;
      const fId = this._extrudeMode.editingFeatureId;
      this._partManager.modifyFeature(fId, (f) => {
        f.distance = orig.distance;
        f.direction = orig.direction;
        f.symmetric = orig.symmetric;
        f.operation = orig.operation;
        f.extrudeType = orig.extrudeType;
        f.taper = orig.taper;
        f.taperAngle = orig.taperAngle;
        f.taperInward = orig.taperInward;
      });
    }

    this._exitExtrudeMode();
    this._update3DView();
    this._updateOperationButtons();
    this.setStatus('Extrude cancelled.');
  }

  /**
   * Clean up extrude mode state and UI.
   */
  _exitExtrudeMode() {
    if (!this._extrudeMode) return;

    // Clear ghost preview and handle arrow
    if (this._renderer3d) {
      this._renderer3d.clearGhostPreview();
      this._renderer3d.clearExtrudeArrow();
    }
    this._extrudeHandleInfo = null;
    this._draggingExtrudeHandle = false;
    this._extrudeArrowHoveredState = false;
    const exitBtn = document.getElementById('btn-exit-extrude');
    if (exitBtn) exitBtn.style.display = 'none';

    // Remove active class from extrude buttons
    const btnExtrude = document.getElementById('btn-extrude');
    if (btnExtrude) btnExtrude.classList.remove('active');
    const btnExtrudeCut = document.getElementById('btn-extrude-cut');
    if (btnExtrudeCut) btnExtrudeCut.classList.remove('active');

    this._extrudeMode = null;

    // Restore left panel to selection summary
    this._showLeftFeatureParams(null);
    this._scheduleRender();
  }

  // -----------------------------------------------------------------------
  // Chamfer
  // -----------------------------------------------------------------------

  _startChamfer() {
    if (this._workspaceMode !== 'part') {
      this.setStatus('Chamfer is only available in Part workspace.');
      return;
    }
    if (this._extrudeMode || this._chamferMode || this._filletMode) return;

    this._chamferMode = {
      edgeKeys: [],
      distance: 1,
      editingFeatureId: null,
    };
    this._selectedFacesForEdges = new Map(); // faceIndex → edgeIndices[]

    if (this._renderer3d) {
      this._renderer3d.setEdgeSelectionMode(true);
      this._renderer3d.selectFace(-1);
    }
    this._selectedFaces.clear();

    const btnChamfer = document.getElementById('btn-chamfer');
    if (btnChamfer) btnChamfer.classList.add('active');

    this._showChamferUI();
    this._updateOperationButtons();
    this.setStatus('Chamfer: Click edges to select, then adjust distance and accept.');
  }

  _showChamferUI() {
    const container = document.getElementById('left-feature-params-content');
    if (!container || !this._chamferMode) return;
    container.innerHTML = '';

    const cm = this._chamferMode;
    const header = document.createElement('div');
    header.className = 'parameter-row';
    header.innerHTML = `<label class="parameter-label" style="font-weight:600">Chamfer${cm.editingFeatureId ? ' (Edit)' : ''}</label>`;
    container.appendChild(header);

    // Hint text
    const hint = document.createElement('div');
    hint.className = 'hint edge-selection-hint';
    hint.textContent = 'Click edge to select. Click face to select all edges. Shift+click to add, Ctrl+click to toggle.';
    container.appendChild(hint);

    // Selection list
    container.appendChild(this._buildEdgeSelectionList());

    // Distance
    container.appendChild(this._createParamRow('Distance', 'number', cm.distance, (v) => {
      const parsed = parseFloat(v);
      if (!isNaN(parsed) && parsed > 0) {
        cm.distance = parsed;
        this._updateChamferPreview();
      }
    }));

    // Accept / Cancel
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:12px;padding:0 4px';
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept';
    acceptBtn.className = 'param-btn accept';
    acceptBtn.style.cssText = 'flex:1;padding:6px;background:#4caf50;color:#fff;border:none;border-radius:4px;cursor:pointer';
    acceptBtn.addEventListener('click', () => this._acceptChamfer());
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'param-btn cancel';
    cancelBtn.style.cssText = 'flex:1;padding:6px;background:#f44336;color:#fff;border:none;border-radius:4px;cursor:pointer';
    cancelBtn.addEventListener('click', () => this._cancelChamfer());
    btnRow.appendChild(acceptBtn);
    btnRow.appendChild(cancelBtn);
    container.appendChild(btnRow);

    // Trigger preview update when edges change
    this._updateChamferPreview();
  }

  _acceptChamfer() {
    if (!this._chamferMode) return;
    const cm = this._chamferMode;

    const edgeKeys = this._renderer3d ? this._renderer3d.getSelectedEdgeKeys() : [];
    if (edgeKeys.length === 0) {
      this.setStatus('Select at least one edge for chamfer.');
      return;
    }

    try {
      if (cm.editingFeatureId) {
        // Update existing feature
        this._partManager.modifyFeature(cm.editingFeatureId, (f) => {
          f.distance = cm.distance;
          f.edgeKeys = edgeKeys;
        });
      } else {
        this._partManager.chamfer(edgeKeys, cm.distance);
      }
      this._recorder.chamferCreated(edgeKeys, cm.distance);
      this._exitChamferMode();
      this._deselectAll();
      this._featurePanel.update();
      this._updateNodeTree();
      this._update3DView();
      this._updateOperationButtons();
      this.setStatus(`Chamfer: ${cm.distance} units on ${edgeKeys.length} edge(s)`);
    } catch (err) {
      this.setStatus(`Chamfer failed: ${err.message}`);
    }
  }

  _cancelChamfer() {
    this._exitChamferMode();
    this._update3DView();
    this._updateOperationButtons();
    this.setStatus('Chamfer cancelled.');
  }

  _exitChamferMode() {
    if (!this._chamferMode) return;
    if (this._renderer3d) {
      this._renderer3d.setEdgeSelectionMode(false);
      this._renderer3d.clearGhostPreview();
      this._renderer3d.setHoveredEdge(-1);
      this._renderer3d.setHoveredFace(-1);
    }
    const btnChamfer = document.getElementById('btn-chamfer');
    if (btnChamfer) btnChamfer.classList.remove('active');
    this._chamferMode = null;
    this._showLeftFeatureParams(null);
    this._scheduleRender();
  }

  // -----------------------------------------------------------------------
  // Fillet
  // -----------------------------------------------------------------------

  _startFillet() {
    if (this._workspaceMode !== 'part') {
      this.setStatus('Fillet is only available in Part workspace.');
      return;
    }
    if (this._extrudeMode || this._chamferMode || this._filletMode) return;

    this._filletMode = {
      edgeKeys: [],
      radius: 1,
      segments: 8,
      editingFeatureId: null,
    };
    this._selectedFacesForEdges = new Map(); // faceIndex → edgeIndices[]

    if (this._renderer3d) {
      this._renderer3d.setEdgeSelectionMode(true);
      this._renderer3d.selectFace(-1);
    }
    this._selectedFaces.clear();

    const btnFillet = document.getElementById('btn-fillet');
    if (btnFillet) btnFillet.classList.add('active');

    this._showFilletUI();
    this._updateOperationButtons();
    this.setStatus('Fillet: Click edges to select, then adjust radius and accept.');
  }

  _showFilletUI() {
    const container = document.getElementById('left-feature-params-content');
    if (!container || !this._filletMode) return;
    container.innerHTML = '';

    const fm = this._filletMode;
    const header = document.createElement('div');
    header.className = 'parameter-row';
    header.innerHTML = `<label class="parameter-label" style="font-weight:600">Fillet${fm.editingFeatureId ? ' (Edit)' : ''}</label>`;
    container.appendChild(header);

    // Hint text
    const hint = document.createElement('div');
    hint.className = 'hint edge-selection-hint';
    hint.textContent = 'Click edge to select. Click face to select all edges. Shift+click to add, Ctrl+click to toggle.';
    container.appendChild(hint);

    // Selection list
    container.appendChild(this._buildEdgeSelectionList());

    // Radius
    container.appendChild(this._createParamRow('Radius', 'number', fm.radius, (v) => {
      const parsed = parseFloat(v);
      if (!isNaN(parsed) && parsed > 0) {
        fm.radius = parsed;
        this._updateFilletPreview();
      }
    }));

    // Segments
    container.appendChild(this._createParamRow('Segments', 'number', fm.segments, (v) => {
      const parsed = parseInt(v, 10);
      if (!isNaN(parsed) && parsed >= 2 && parsed <= 32) {
        fm.segments = parsed;
        this._updateFilletPreview();
      }
    }));

    // Accept / Cancel
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:12px;padding:0 4px';
    const acceptBtn = document.createElement('button');
    acceptBtn.textContent = 'Accept';
    acceptBtn.className = 'param-btn accept';
    acceptBtn.style.cssText = 'flex:1;padding:6px;background:#4caf50;color:#fff;border:none;border-radius:4px;cursor:pointer';
    acceptBtn.addEventListener('click', () => this._acceptFillet());
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'param-btn cancel';
    cancelBtn.style.cssText = 'flex:1;padding:6px;background:#f44336;color:#fff;border:none;border-radius:4px;cursor:pointer';
    cancelBtn.addEventListener('click', () => this._cancelFillet());
    btnRow.appendChild(acceptBtn);
    btnRow.appendChild(cancelBtn);
    container.appendChild(btnRow);

    // Trigger preview update when edges change
    this._updateFilletPreview();
  }

  _acceptFillet() {
    if (!this._filletMode) return;
    const fm = this._filletMode;

    const edgeKeys = this._renderer3d ? this._renderer3d.getSelectedEdgeKeys() : [];
    if (edgeKeys.length === 0) {
      this.setStatus('Select at least one edge for fillet.');
      return;
    }

    try {
      if (fm.editingFeatureId) {
        // Update existing feature
        this._partManager.modifyFeature(fm.editingFeatureId, (f) => {
          f.radius = fm.radius;
          f.segments = fm.segments;
          f.edgeKeys = edgeKeys;
        });
      } else {
        this._partManager.fillet(edgeKeys, fm.radius, { segments: fm.segments });
      }
      this._recorder.filletCreated(edgeKeys, fm.radius, fm.segments);
      this._exitFilletMode();
      this._deselectAll();
      this._featurePanel.update();
      this._updateNodeTree();
      this._update3DView();
      this._updateOperationButtons();
      this.setStatus(`Fillet: radius ${fm.radius} on ${edgeKeys.length} edge(s)`);
    } catch (err) {
      this.setStatus(`Fillet failed: ${err.message}`);
    }
  }

  _cancelFillet() {
    this._exitFilletMode();
    this._update3DView();
    this._updateOperationButtons();
    this.setStatus('Fillet cancelled.');
  }

  _exitFilletMode() {
    if (!this._filletMode) return;
    if (this._renderer3d) {
      this._renderer3d.setEdgeSelectionMode(false);
      this._renderer3d.clearGhostPreview();
      this._renderer3d.setHoveredEdge(-1);
      this._renderer3d.setHoveredFace(-1);
    }
    const btnFillet = document.getElementById('btn-fillet');
    if (btnFillet) btnFillet.classList.remove('active');
    this._filletMode = null;
    this._showLeftFeatureParams(null);
    this._scheduleRender();
  }

  /**
   * Build a unified selection list panel showing all currently selected items
   * (planes, faces, features, edges) with × remove buttons and hover highlights.
   * Reused in selection summary, chamfer UI, fillet UI, etc.
   * @returns {HTMLElement}
   */
  _buildSelectionList() {
    const wrapper = document.createElement('div');
    wrapper.className = 'edge-selection-list';

    // Collect all selected items
    const items = [];

    // Plane
    if (this._selectedPlane) {
      items.push({
        icon: '📏', label: `${this._selectedPlane} Plane`, type: 'plane',
        onHover: () => { if (this._renderer3d) { this._renderer3d.setHoveredPlane(this._selectedPlane); this._scheduleRender(); } },
        onLeave: () => { if (this._renderer3d) { this._renderer3d.setHoveredPlane(null); this._scheduleRender(); } },
        onRemove: () => { this._selectedPlane = null; if (this._renderer3d) this._renderer3d.setSelectedPlane(null); this._refreshSelectionUI(); this._scheduleRender(); }
      });
    }

    // Face (selected in default mode, not edge-selection mode)
    if (this._selectedFaces.size > 0) {
      for (const [fIdx, fHit] of this._selectedFaces) {
        const faceIdx = fHit.faceIndex != null ? fHit.faceIndex : '?';
        items.push({
          icon: '🔲', label: `Face ${faceIdx}`, type: 'face',
          onHover: () => { if (this._renderer3d) { this._renderer3d.setHoveredFace(fHit.faceIndex); this._scheduleRender(); } },
          onLeave: () => { if (this._renderer3d) { this._renderer3d.setHoveredFace(-1); this._scheduleRender(); } },
          onRemove: () => { this._selectedFaces.delete(fIdx); if (this._renderer3d) this._renderer3d.removeFaceSelection(fIdx); this._refreshSelectionUI(); this._scheduleRender(); }
        });
      }
    }

    // Feature
    if (this._renderer3d && this._renderer3d._selectedFeatureId) {
      const fId = this._renderer3d._selectedFeatureId;
      const features = this._partManager ? this._partManager.getFeatures() : [];
      const feat = features.find(f => f.id === fId);
      items.push({
        iconHtml: getFeatureIconSVG(feat ? feat.type : 'sketch'), label: feat ? feat.name : fId, type: 'feature',
        onHover: () => {},
        onLeave: () => {},
        onRemove: () => { if (this._renderer3d) this._renderer3d.setSelectedFeature(null); if (this._featurePanel) this._featurePanel.selectFeature(null); this._refreshSelectionUI(); this._scheduleRender(); }
      });
    }

    // Faces selected for edge extraction (chamfer/fillet mode)
    const faceEdgeIndices = new Set(); // track which edge indices belong to a face selection
    if (this._selectedFacesForEdges && this._selectedFacesForEdges.size > 0) {
      for (const [faceIdx, edgeIndices] of this._selectedFacesForEdges) {
        for (const i of edgeIndices) faceEdgeIndices.add(i);
        items.push({
          icon: '🔲', label: `Face ${faceIdx}`, type: 'face-edges',
          onHover: () => { if (this._renderer3d) { this._renderer3d.setHoveredFace(faceIdx); this._scheduleRender(); } },
          onLeave: () => { if (this._renderer3d) { this._renderer3d.setHoveredFace(-1); this._scheduleRender(); } },
          onRemove: () => {
            if (this._renderer3d) { for (const i of edgeIndices) this._renderer3d._selectedEdgeIndices.delete(i); }
            if (this._selectedFacesForEdges) this._selectedFacesForEdges.delete(faceIdx);
            this._refreshSelectionUI(); this._scheduleRender();
          }
        });
      }
    }

    // Edges (grouped by path) — only show edges NOT covered by a face selection
    const edgeEntries = this._getSelectedPathEntries();
    for (const entry of edgeEntries) {
      // Skip if all edges in this entry belong to a face selection
      if (entry.edgeIndices.every(i => faceEdgeIndices.has(i))) continue;
      items.push({
        icon: '🔗', label: entry.label, type: 'edge',
        onHover: () => { if (this._renderer3d && entry.edgeIndices.length > 0) { this._renderer3d.setHoveredEdge(entry.edgeIndices[0]); this._scheduleRender(); } },
        onLeave: () => { if (this._renderer3d) { this._renderer3d.setHoveredEdge(-1); this._scheduleRender(); } },
        onRemove: () => { if (this._renderer3d) { for (const i of entry.edgeIndices) this._renderer3d._selectedEdgeIndices.delete(i); this._refreshSelectionUI(); this._scheduleRender(); } }
      });
    }

    // Count
    const labelRow = document.createElement('div');
    labelRow.className = 'parameter-row';
    labelRow.innerHTML = `<label class="parameter-label">Selection</label><span class="parameter-value">${items.length} item${items.length !== 1 ? 's' : ''}</span>`;
    wrapper.appendChild(labelRow);

    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'edge-selection-empty';
      empty.textContent = 'Nothing selected';
      wrapper.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'edge-selection-items';
      for (const item of items) {
        const el = document.createElement('div');
        el.className = 'edge-selection-item';

        const iconSpan = document.createElement('span');
        iconSpan.style.cssText = 'opacity:0.6;flex-shrink:0';
        if (item.iconHtml) {
          iconSpan.classList.add('node-tree-icon');
          iconSpan.innerHTML = item.iconHtml;
        } else {
          iconSpan.textContent = item.icon;
        }

        const label = document.createElement('span');
        label.className = 'edge-selection-label';
        label.textContent = item.label;
        label.addEventListener('mouseenter', item.onHover);
        label.addEventListener('mouseleave', item.onLeave);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'edge-selection-remove';
        removeBtn.textContent = '\u00d7';
        removeBtn.title = `Remove ${item.label}`;
        removeBtn.addEventListener('click', (ev) => { ev.stopPropagation(); item.onRemove(); });

        el.appendChild(iconSpan);
        el.appendChild(label);
        el.appendChild(removeBtn);
        list.appendChild(el);
      }
      wrapper.appendChild(list);

      // Clear All button
      const clearBtn = document.createElement('button');
      clearBtn.className = 'edge-selection-clear';
      clearBtn.textContent = 'Clear All';
      clearBtn.addEventListener('click', () => {
        this._selectedFaces.clear();
        this._selectedPlane = null;
        this._selectedFacesForEdges = new Map();
        if (this._renderer3d) {
          this._renderer3d.clearFaceSelection();
          this._renderer3d.setSelectedPlane(null);
          this._renderer3d.setSelectedFeature(null);
          this._renderer3d.clearEdgeSelection();
        }
        if (this._featurePanel) this._featurePanel.selectFeature(null);
        this._refreshSelectionUI();
        this._scheduleRender();
      });
      wrapper.appendChild(clearBtn);
    }

    return wrapper;
  }

  /**
   * Refresh the selection UI after a selection change.
   * Routes to the correct UI builder depending on the current mode.
   */
  _refreshSelectionUI() {
    if (this._chamferMode) this._showChamferUI();
    else if (this._filletMode) this._showFilletUI();
    else this._showLeftFeatureParams(null);
    this._updateOperationButtons();
  }

  /**
   * Build the edge selection list panel showing each selected path/edge with a × remove button.
   * Groups edges by path and shows a compact label for each.
   * @returns {HTMLElement}
   * @deprecated Use _buildSelectionList() instead
   */
  _buildEdgeSelectionList() {
    return this._buildSelectionList();
  }

  /**
   * Get selected edges grouped by path for the selection list.
   * @returns {{label: string, key: string, edgeIndices: number[]}[]}
   */
  _getSelectedPathEntries() {
    if (!this._renderer3d || !this._renderer3d._meshEdgeSegments) return [];
    const seen = new Set();
    const entries = [];

    for (const idx of this._renderer3d._selectedEdgeIndices) {
      const pathIdx = this._renderer3d._edgeToPath ? this._renderer3d._edgeToPath.get(idx) : undefined;
      const groupKey = pathIdx !== undefined ? `path:${pathIdx}` : `edge:${idx}`;
      if (seen.has(groupKey)) continue;
      seen.add(groupKey);

      let edgeIndices;
      if (pathIdx !== undefined && this._renderer3d._meshEdgePaths) {
        edgeIndices = this._renderer3d._meshEdgePaths[pathIdx].edgeIndices;
      } else {
        edgeIndices = [idx];
      }

      let label;
      if (edgeIndices.length === 1) {
        label = `Edge ${idx}`;
      } else {
        label = `Edge group ${pathIdx} (${edgeIndices.length} segments)`;
      }

      entries.push({ label, key: groupKey, edgeIndices });
    }
    return entries;
  }

  /** Called when edge selection changes (click toggle) — refresh UI. */
  _onEdgeSelectionChanged() {
    this._refreshSelectionUI();
  }

  // -----------------------------------------------------------------------
  // Chamfer/Fillet Preview
  // -----------------------------------------------------------------------

  /** Compute and display a live preview of the chamfer result. */
  _updateChamferPreview() {
    if (!this._chamferMode || !this._renderer3d) return;
    const cm = this._chamferMode;
    const edgeKeys = this._renderer3d.getSelectedEdgeKeys();
    if (edgeKeys.length === 0) {
      this._renderer3d.clearGhostPreview();
      this._scheduleRender();
      return;
    }

    const part = this._partManager.getPart();
    if (!part) return;

    // Get base geometry (before this feature for edits, or current for new)
    let baseResult;
    if (cm.editingFeatureId) {
      baseResult = part.getGeometryBeforeFeature(cm.editingFeatureId);
    } else {
      baseResult = part.getFinalGeometry();
    }
    if (!baseResult || !baseResult.geometry) return;

    try {
      const resolvedKeys = expandPathEdgeKeys(baseResult.geometry, edgeKeys);
      const preview = applyChamfer(baseResult.geometry, resolvedKeys, cm.distance);
      this._renderer3d.setGhostPreview(preview);
      this._scheduleRender();
    } catch (_) {
      // Preview computation failed — leave current view
    }
  }

  /** Compute and display a live preview of the fillet result. */
  _updateFilletPreview() {
    if (!this._filletMode || !this._renderer3d) return;
    const fm = this._filletMode;
    const edgeKeys = this._renderer3d.getSelectedEdgeKeys();
    if (edgeKeys.length === 0) {
      this._renderer3d.clearGhostPreview();
      this._scheduleRender();
      return;
    }

    const part = this._partManager.getPart();
    if (!part) return;

    let baseResult;
    if (fm.editingFeatureId) {
      baseResult = part.getGeometryBeforeFeature(fm.editingFeatureId);
    } else {
      baseResult = part.getFinalGeometry();
    }
    if (!baseResult || !baseResult.geometry) return;

    try {
      const resolvedKeys = expandPathEdgeKeys(baseResult.geometry, edgeKeys);
      const preview = applyFillet(baseResult.geometry, resolvedKeys, fm.radius, fm.segments);
      this._renderer3d.setGhostPreview(preview);
      this._scheduleRender();
    } catch (_) {
      // Preview computation failed — leave current view
    }
  }

  // -----------------------------------------------------------------------
  // Edit Edges for existing Chamfer/Fillet features
  // -----------------------------------------------------------------------

  /** Enter edge editing mode for an existing chamfer feature. */
  _editChamferEdges(feature) {
    if (this._extrudeMode || this._chamferMode || this._filletMode) return;

    // Need to show geometry BEFORE this feature so edges can be selected
    const part = this._partManager.getPart();
    if (!part) return;
    const baseResult = part.getGeometryBeforeFeature(feature.id);
    if (!baseResult || !baseResult.geometry) {
      this.setStatus('Cannot edit edges: no base geometry found.');
      return;
    }

    this._chamferMode = {
      edgeKeys: [...feature.edgeKeys],
      distance: feature.distance,
      editingFeatureId: feature.id,
    };
    this._selectedFacesForEdges = new Map();

    if (this._renderer3d) {
      // Display the base geometry (before chamfer) so edges are visible
      this._renderer3d.renderPreviewGeometry(baseResult.geometry);
      this._renderer3d.setEdgeSelectionMode(true);
      this._renderer3d.selectFace(-1);
      // Pre-select the feature's existing edges
      this._renderer3d.selectEdgesByKeys(feature.edgeKeys);
    }
    this._selectedFaces.clear();

    const btnChamfer = document.getElementById('btn-chamfer');
    if (btnChamfer) btnChamfer.classList.add('active');

    this._showChamferUI();
    this._updateOperationButtons();
    this._scheduleRender();
    this.setStatus('Edit Chamfer: Modify edge selection and distance, then Accept.');
  }

  /** Enter edge editing mode for an existing fillet feature. */
  _editFilletEdges(feature) {
    if (this._extrudeMode || this._chamferMode || this._filletMode) return;

    const part = this._partManager.getPart();
    if (!part) return;
    const baseResult = part.getGeometryBeforeFeature(feature.id);
    if (!baseResult || !baseResult.geometry) {
      this.setStatus('Cannot edit edges: no base geometry found.');
      return;
    }

    this._filletMode = {
      edgeKeys: [...feature.edgeKeys],
      radius: feature.radius,
      segments: feature.segments || 8,
      editingFeatureId: feature.id,
    };
    this._selectedFacesForEdges = new Map();

    if (this._renderer3d) {
      this._renderer3d.renderPreviewGeometry(baseResult.geometry);
      this._renderer3d.setEdgeSelectionMode(true);
      this._renderer3d.selectFace(-1);
      this._renderer3d.selectEdgesByKeys(feature.edgeKeys);
    }
    this._selectedFaces.clear();

    const btnFillet = document.getElementById('btn-fillet');
    if (btnFillet) btnFillet.classList.add('active');

    this._showFilletUI();
    this._updateOperationButtons();
    this._scheduleRender();
    this.setStatus('Edit Fillet: Modify edge selection, radius and segments, then Accept.');
  }
}


// Bootstrap
window.addEventListener('DOMContentLoaded', () => {
  window.cadApp = new App();
});

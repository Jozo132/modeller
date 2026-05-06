// js/tools/SelectTool.js
import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { Scene } from '../cad/index.js';
import { union } from '../cad/Operations.js';
import { OnLine, OnCircle } from '../cad/Constraint.js';
import { computeFullyConstrained } from '../cad/ConstraintAnalysis.js';

const PICK_PX = 18;       // pixel tolerance for shape picking
const PICK_PT_PX = 14;    // pixel tolerance for point picking (tighter — points are small)
const DRAG_THRESHOLD = 5; // min pixels before a drag starts
const ALIGN_TOL_PX = 5;   // pixel tolerance for alignment guide detection
const POLYGON_EPSILON = 1e-9;
const DRAG_SETTLE_EXTRA_ITERATIONS = 5;
const LIVE_DRAG_SOLVE_OPTIONS = { maxIter: 800, relaxation: 1, tolerance: 1e-4 };
const LIVE_DRAG_ORTHOGONAL_SLACK = 2e-3;

/** Collect the unique movable points of a shape. */
function _shapePoints(shape) {
  if (shape.type === 'segment') return [shape.p1, shape.p2];
  if (shape.type === 'circle') return [shape.center];
  if (shape.type === 'arc') return [shape.center, shape.startPoint, shape.endPoint].filter(Boolean);
  if (shape.type === 'group') return [];
  return [];
}

function _pointInPolygon(px, py, polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const denom = yj - yi;
    if (Math.abs(denom) < POLYGON_EPSILON) continue;
    const intersects = ((yi > py) !== (yj > py))
      && (px < ((xj - xi) * (py - yi)) / denom + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

/** True when every defining point of a primitive is fully locked. */
function _isFullyConstrained(prim, fc = computeFullyConstrained(state.scene)) {
  if (prim.type === 'point') return prim.fixed || fc.points.has(prim);
  return fc.entities.has(prim);
}

export class SelectTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'select';
    this._dragStart = null;
    this._isDragging = false;
    this._selectionBox = null;

    // Vertex drag state
    this._dragPoint = null;       // PPoint being dragged
    this._dragTookSnapshot = false;

    // Shape drag state
    this._dragShape = null;       // shape being dragged (segment / circle / arc)
    this._dragShapePts = [];      // non-fixed points of that shape
    this._dragRadiusShape = null; // circle/arc edge radius being dragged
    this._dragArcEndpoint = null; // { arc, which } for arc endpoint drags
    this._dragImageHandle = null; // { image, index }

    // Dimension drag state (repositioning the offset)
    this._dragDimension = null;   // DimensionPrimitive being dragged

    // Snap-to-coincidence state
    this._snapCandidates = [];    // [{dragPt, targetPt, x, y}, ...] — nearby points to merge on drop

    // Point-to-edge snap state
    this._lineSnapCandidates = []; // [{dragPt, shape, x, y, kind}, ...] — points to constrain to an edge on drop

    // Alignment guide state (visual only, no constraints)
    this._alignmentGuides = [];   // [{axis:'h'|'v', dragPt, matchPt, value}, ...]
    this._dragCancelState = null;
    this._dragSolvedPointState = null;
    this._dragAcceptedMaxError = Number.POSITIVE_INFINITY;
    this._dragSettleFrameId = 0;
    this._dragSettleRemaining = 0;
    this._dragSettleTarget = null;
  }

  activate() {
    super.activate();
    this.app.renderer.hoverEntity = null;
    this.setStatus('Click to select, drag for box selection, drag a point/shape to move it');
  }

  deactivate() {
    this.app.renderer.hoverEntity = null;
    this._dragPoint = null;
    this._dragShape = null;
    this._dragShapePts = [];
    this._dragRadiusShape = null;
    this._dragArcEndpoint = null;
    this._dragImageHandle = null;
    this._dragDimension = null;
    this._snapCandidates = [];
    this._lineSnapCandidates = [];
    this._alignmentGuides = [];
    this._dragCancelState = null;
    this._clearDragSettle();
    super.deactivate();
  }

  _clearDragSettle() {
    if (this._dragSettleFrameId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this._dragSettleFrameId);
    }
    this._dragSettleFrameId = 0;
    this._dragSettleRemaining = 0;
    this._dragSettleTarget = null;
  }

  _captureSceneDragState() {
    if (this._dragCancelState) return;
    this._dragCancelState = {
      kind: 'scene',
      sceneData: state.scene.serialize(),
      selectedEntityIds: state.selectedEntities.map((entity) => entity.id),
    };
  }

  _captureImageHandleDragState(image) {
    if (this._dragCancelState) return;
    this._dragCancelState = {
      kind: 'image-handle',
      image,
      draftQuad: typeof image.getPerspectiveGuideQuad === 'function'
        ? image.getPerspectiveGuideQuad().map((point) => ({ u: point.u, v: point.v }))
        : null,
      targetQuad: typeof image.getPerspectiveDraftTargetQuad === 'function'
        ? image.getPerspectiveDraftTargetQuad()
        : null,
    };
  }

  _resetDragState() {
    this._clearDragSettle();
    this._dragPoint = null;
    this._dragShape = null;
    this._dragShapePts = [];
    this._dragRadiusShape = null;
    this._dragArcEndpoint = null;
    this._dragImageHandle = null;
    this._dragDimension = null;
    this._snapCandidates = [];
    this._lineSnapCandidates = [];
    this._alignmentGuides = [];
    this._isDragging = false;
    this._dragStart = null;
    this._selectionBox = null;
    this._dragTookSnapshot = false;
    this._dragCancelState = null;
    this._dragSolvedPointState = null;
    this._dragAcceptedMaxError = Number.POSITIVE_INFINITY;
  }

  _currentConstraintMaxError() {
    let maxError = 0;
    for (const constraint of state.scene.constraints || []) {
      const error = Number(constraint?.error?.());
      if (!Number.isFinite(error)) return Number.POSITIVE_INFINITY;
      if (error > maxError) maxError = error;
    }
    return maxError;
  }

  _snapshotScenePointPositions() {
    return state.scene.points.map((point) => ({ point, x: point.x, y: point.y }));
  }

  _restoreScenePointPositions(snapshot) {
    if (!Array.isArray(snapshot)) return;
    for (const entry of snapshot) {
      if (!entry?.point) continue;
      entry.point.x = entry.x;
      entry.point.y = entry.y;
    }
  }

  _commitSolvedPointState() {
    this._dragSolvedPointState = this._snapshotScenePointPositions();
    this._dragAcceptedMaxError = this._currentConstraintMaxError();
  }

  _findDraggedPointSnapshot(point) {
    if (!point || !Array.isArray(this._dragSolvedPointState)) return null;
    return this._dragSolvedPointState.find((entry) => entry?.point === point) || null;
  }

  _stabilizeDraggedSolve(result) {
    if (!result || !Array.isArray(this._dragSolvedPointState) || this._dragSolvedPointState.length === 0) return;

    const draggedPoints = [];
    if (this._dragPoint) {
      draggedPoints.push(this._dragPoint);
      if (this._dragArcEndpoint?.arc) {
        draggedPoints.push(this._dragArcEndpoint.arc.startPoint, this._dragArcEndpoint.arc.endPoint);
      }
    } else if (Array.isArray(this._dragShapePts) && this._dragShapePts.length > 0) {
      draggedPoints.push(...this._dragShapePts);
    }
    if (draggedPoints.length === 0) return;

    let deltaX = 0;
    let deltaY = 0;
    let deltaCount = 0;
    for (const point of draggedPoints) {
      const previous = this._findDraggedPointSnapshot(point);
      if (!previous) continue;
      deltaX += point.x - previous.x;
      deltaY += point.y - previous.y;
      deltaCount++;
    }
    if (deltaCount === 0) return;

    const absDx = Math.abs(deltaX);
    const absDy = Math.abs(deltaY);
    if (absDx <= 1e-9 && absDy <= 1e-9) return;

    const lockedAxis = absDx >= absDy ? 'y' : 'x';
    const protectedPoints = new Set(draggedPoints);
    const solvedState = this._snapshotScenePointPositions();
    let changed = false;

    for (const entry of this._dragSolvedPointState) {
      if (!entry?.point || protectedPoints.has(entry.point) || entry.point.fixed === true) continue;
      if (Math.abs(entry.point[lockedAxis] - entry[lockedAxis]) <= 1e-12) continue;
      entry.point[lockedAxis] = entry[lockedAxis];
      changed = true;
    }

    if (!changed) return;

    const stabilizedError = this._currentConstraintMaxError();
    const baseError = Number(result.maxError);
    const allowedError = Number.isFinite(baseError)
      ? baseError + LIVE_DRAG_ORTHOGONAL_SLACK
      : Number.POSITIVE_INFINITY;

    if (Number.isFinite(stabilizedError) && stabilizedError <= allowedError) {
      result.maxError = stabilizedError;
      result.converged = stabilizedError <= LIVE_DRAG_SOLVE_OPTIONS.tolerance;
      return;
    }

    this._restoreScenePointPositions(solvedState);
  }

  _beginConstrainedDragIfNeeded() {
    if (this._dragSolvedPointState) return;
    this._dragSolvedPointState = this._snapshotScenePointPositions();
    this._dragAcceptedMaxError = this._currentConstraintMaxError();
  }

  _shouldAcceptDraggedSolve(result) {
    if (!result) return false;
    if (result.converged) return true;
    const maxError = Number(result.maxError);
    if (!Number.isFinite(maxError)) return false;
    const acceptedMaxError = Number.isFinite(this._dragAcceptedMaxError)
      ? this._dragAcceptedMaxError
      : Number.POSITIVE_INFINITY;
    const slack = Math.max(LIVE_DRAG_SOLVE_OPTIONS.tolerance, 1e-6);
    return maxError <= acceptedMaxError + slack;
  }

  _solveDraggedConstraintState(fallback = null) {
    const solveOptions = LIVE_DRAG_SOLVE_OPTIONS;
    const result = state.scene.solve(solveOptions);
    if (this._shouldAcceptDraggedSolve(result)) {
      this._stabilizeDraggedSolve(result);
      this._commitSolvedPointState();
      return true;
    }
    if (typeof fallback === 'function') {
      this._restoreScenePointPositions(this._dragSolvedPointState);
      fallback();
      const relaxedResult = state.scene.solve(solveOptions);
      if (this._shouldAcceptDraggedSolve(relaxedResult)) {
        this._stabilizeDraggedSolve(relaxedResult);
        this._commitSolvedPointState();
        return true;
      }
    }
    this._restoreScenePointPositions(this._dragSolvedPointState);
    state.scene.solve(solveOptions);
    return false;
  }

  _applyDraggedPointTarget(targetX, targetY) {
    this._dragPoint.x = targetX;
    this._dragPoint.y = targetY;
    const wasFixed = this._dragPoint.fixed;
    this._dragPoint.fixed = true;
    const solved = this._solveDraggedConstraintState(() => {
      this._dragPoint.x = targetX;
      this._dragPoint.y = targetY;
      this._dragPoint.fixed = false;
    });
    this._dragPoint.fixed = wasFixed;

    if (solved && state.autoCoincidence) {
      this._snapCandidates = this._findSnapCandidates([this._dragPoint]);
      this._lineSnapCandidates = this._findLineSnapCandidates([this._dragPoint]);
    } else {
      this._snapCandidates = [];
      this._lineSnapCandidates = [];
    }
    this._alignmentGuides = solved ? this._findAlignmentGuides([this._dragPoint]) : [];

    state.emit('change');
    return solved;
  }

  _applyDraggedArcEndpointTarget(targetX, targetY) {
    const drag = this._dragArcEndpoint;
    if (!drag?.arc) return this._applyDraggedPointTarget(targetX, targetY);

    drag.arc.setEndpointPosition(drag.which, targetX, targetY);
    const endpoint = drag.which === 'start' ? drag.arc.startPoint : drag.arc.endPoint;
    const wasFixed = endpoint?.fixed;
    if (endpoint) endpoint.fixed = true;
    const solved = this._solveDraggedConstraintState(() => {
      drag.arc.setEndpointPosition(drag.which, targetX, targetY);
      if (endpoint) endpoint.fixed = false;
    });
    if (endpoint) endpoint.fixed = wasFixed;

    const dragPts = [endpoint].filter(Boolean);
    if (solved && state.autoCoincidence) {
      this._snapCandidates = this._findSnapCandidates(dragPts);
      this._lineSnapCandidates = this._findLineSnapCandidates(dragPts);
    } else {
      this._snapCandidates = [];
      this._lineSnapCandidates = [];
    }
    this._alignmentGuides = solved ? this._findAlignmentGuides(dragPts) : [];

    state.emit('change');
    return solved;
  }

  _applyDraggedRadiusTarget(wx, wy) {
    const shape = this._dragRadiusShape;
    if (!shape) return false;
    const radius = Math.max(0, Math.hypot(wx - shape.cx, wy - shape.cy));
    shape.radius = radius;
    const solved = this._solveDraggedConstraintState(() => { shape.radius = radius; });
    const dragPts = shape.type === 'arc' ? [shape.startPoint, shape.endPoint].filter(Boolean) : [];

    if (solved && state.autoCoincidence && dragPts.length > 0) {
      this._snapCandidates = this._findSnapCandidates(dragPts);
      this._lineSnapCandidates = this._findLineSnapCandidates(dragPts);
    } else {
      this._snapCandidates = [];
      this._lineSnapCandidates = [];
    }
    this._alignmentGuides = solved && dragPts.length > 0 ? this._findAlignmentGuides(dragPts) : [];

    state.emit('change');
    return solved;
  }

  _applyDraggedShapeTarget(wx, wy) {
    const wdx = wx - this._dragStart.wx;
    const wdy = wy - this._dragStart.wy;
    let solved = true;

    if (this._dragShapePts.length > 0) {
      const movedPoints = this._dragShapePts.map((point) => ({ point, x: point.x + wdx, y: point.y + wdy }));
      const savedFixed = this._dragShapePts.map((point) => point.fixed);
      for (const moved of movedPoints) {
        moved.point.x = moved.x;
        moved.point.y = moved.y;
      }
      for (const point of this._dragShapePts) {
        point.fixed = true;
      }
      solved = this._solveDraggedConstraintState(() => {
        for (const moved of movedPoints) {
          moved.point.x = moved.x;
          moved.point.y = moved.y;
        }
        for (const point of this._dragShapePts) {
          point.fixed = false;
        }
      });
      for (let index = 0; index < this._dragShapePts.length; index++) {
        this._dragShapePts[index].fixed = savedFixed[index];
      }

      if (solved) {
        this._dragStart.wx = wx;
        this._dragStart.wy = wy;
      }

      if (solved && state.autoCoincidence) {
        this._snapCandidates = this._findSnapCandidates(this._dragShapePts);
        this._lineSnapCandidates = this._findLineSnapCandidates(this._dragShapePts);
      } else {
        this._snapCandidates = [];
        this._lineSnapCandidates = [];
      }
      this._alignmentGuides = solved ? this._findAlignmentGuides(this._dragShapePts) : [];
    } else {
      this._dragShape.translate(wdx, wdy);
      this._dragStart.wx = wx;
      this._dragStart.wy = wy;
      this._snapCandidates = [];
      this._lineSnapCandidates = [];
      this._alignmentGuides = [];
    }

    state.emit('change');
    return solved;
  }

  _canReplayDragSettle() {
    return !!(
      this._isDragging
      && this._dragStart
      && this._dragSettleTarget
      && this._dragSettleRemaining > 0
      && (this._dragPoint || this._dragShape || this._dragRadiusShape)
    );
  }

  _scheduleIdleDragSettleFrame() {
    if (this._dragSettleFrameId || typeof requestAnimationFrame !== 'function') return;
    this._dragSettleFrameId = requestAnimationFrame(() => {
      this._dragSettleFrameId = 0;
      if (!this._canReplayDragSettle()) return;
      const { wx: targetX, wy: targetY } = this._dragSettleTarget;
      this._dragSettleRemaining -= 1;
      if (this._dragPoint) {
        if (this._dragArcEndpoint) this._applyDraggedArcEndpointTarget(targetX, targetY);
        else this._applyDraggedPointTarget(targetX, targetY);
      } else if (this._dragShape) {
        this._applyDraggedShapeTarget(targetX, targetY);
      } else if (this._dragRadiusShape) {
        this._applyDraggedRadiusTarget(targetX, targetY);
      }
      if (typeof this.app?._scheduleRender === 'function') {
        this.app._scheduleRender();
      }
      if (this._canReplayDragSettle()) {
        this._scheduleIdleDragSettleFrame();
      }
    });
  }

  _queueIdleDragSettle(wx, wy) {
    if (!(this._dragPoint || this._dragShape || this._dragRadiusShape)) return;
    this._dragSettleTarget = { wx, wy };
    this._dragSettleRemaining = DRAG_SETTLE_EXTRA_ITERATIONS;
    this._scheduleIdleDragSettleFrame();
  }

  _findArcEndpoint(point) {
    for (const arc of state.scene.arcs || []) {
      if (arc.startPoint === point) return { arc, which: 'start' };
      if (arc.endPoint === point) return { arc, which: 'end' };
    }
    return null;
  }

  _arcCenterDragPoints(point) {
    const pts = [];
    const seen = new Set();
    for (const arc of state.scene.arcs || []) {
      if (arc.center !== point) continue;
      for (const p of [arc.center, arc.startPoint, arc.endPoint]) {
        if (p && !p.fixed && !seen.has(p)) {
          seen.add(p);
          pts.push(p);
        }
      }
    }
    return pts;
  }

  _restoreSceneDragState(snapshot) {
    state.scene = Scene.deserialize(snapshot.sceneData);
    const selectedIds = new Set(snapshot.selectedEntityIds || []);
    state.selectedEntities = [];
    for (const entity of [...state.entities, ...(state.scene.groups || [])]) {
      entity.selected = selectedIds.has(entity.id);
      if (entity.selected) state.selectedEntities.push(entity);
    }
    state.emit('selection:change', state.selectedEntities);
  }

  _restoreImageHandleDragState(snapshot) {
    if (!snapshot.image || !Array.isArray(snapshot.draftQuad)) return;
    if (typeof snapshot.image.beginPerspectiveEdit === 'function' && !snapshot.image.isPerspectiveEditing()) {
      snapshot.image.beginPerspectiveEdit();
    }
    if (typeof snapshot.image.setPerspectiveDraftPoint !== 'function') return;
    snapshot.draftQuad.forEach((point, index) => {
      snapshot.image.setPerspectiveDraftPoint(index, point.u, point.v);
    });
    if (typeof snapshot.image.setPerspectiveDraftTargetQuad === 'function') {
      snapshot.image.setPerspectiveDraftTargetQuad(snapshot.targetQuad);
    }
  }

  _cancelActiveDrag() {
    const hadDragGesture = !!(this._dragStart || this._selectionBox || this._dragPoint || this._dragShape || this._dragRadiusShape || this._dragDimension || this._dragImageHandle || this._isDragging);
    const cancelState = this._dragCancelState;
    if (cancelState?.kind === 'scene') {
      this._restoreSceneDragState(cancelState);
    } else if (cancelState?.kind === 'image-handle') {
      this._restoreImageHandleDragState(cancelState);
    }

    this.app.renderer.hoverEntity = null;
    this._resetDragState();

    if (hadDragGesture) {
      state.emit('change');
      this.setStatus('Move canceled.');
      if (typeof this.app._scheduleRender === 'function') this.app._scheduleRender();
    }
    return hadDragGesture;
  }

  // ------------------------------------------------------------------
  //  Hit-testing helpers
  // ------------------------------------------------------------------

  /** Find closest point (vertex) near screen position */
  _findClosestPoint(wx, wy, pixelTolerance = PICK_PT_PX) {
    if (this.app?._activeGroupEditId == null) {
      const shape = this._findClosestEntity(wx, wy, pixelTolerance);
      if (shape?.type === 'group' || (shape && state.scene.groupForPrimitive(shape, this.app?._activeGroupEditId))) return null;
    }
    const worldTol = pixelTolerance / this._effectiveZoom();
    const point = state.scene.findClosestPoint(wx, wy, worldTol);
    if (this.app?._activeGroupEditId != null && point) {
      const owners = state.scene.shapesUsingPoint(point);
      if (owners.length > 0 && !owners.some((shape) => state.scene.isPrimitiveInGroup(shape, this.app._activeGroupEditId))) return null;
    }
    return point;
  }

  /** Find closest shape (segment/circle/arc/text/dim) near screen position */
  _findClosestEntity(wx, wy, pixelTolerance = PICK_PX) {
    const worldTolerance = pixelTolerance / this._effectiveZoom();
    let hit = null;
    let minDist = Infinity;

    for (const entity of state.entities) {
      if (!entity.visible || !state.isLayerVisible(entity.layer)) continue;
      if (this.app?._activeGroupEditId != null && !state.scene.isPrimitiveInGroup(entity, this.app._activeGroupEditId)) continue;
      const d = entity.distanceTo(wx, wy);
      if (d <= worldTolerance && d < minDist) {
        minDist = d;
        hit = entity;
      }
    }
    if (hit && this.app?._activeGroupEditId == null) {
      return state.scene.groupForPrimitive(hit, null) || hit;
    }
    return hit;
  }

  /** Combined hit: prefer point if very close, otherwise shape */
  _hitTest(wx, wy) {
    const pt = this._findClosestPoint(wx, wy, PICK_PT_PX);
    if (pt) return { kind: 'point', target: pt };
    const shape = this._findClosestEntity(wx, wy, PICK_PX);
    if (shape) return { kind: 'shape', target: shape };
    return null;
  }

  _findSelectedImageHandle(wx, wy, pixelTolerance = PICK_PT_PX) {
    const worldTol = pixelTolerance / this._effectiveZoom();
    let best = null;
    let bestDist = Infinity;
    for (const entity of state.selectedEntities) {
      if (!entity || entity.type !== 'image' || typeof entity.isPerspectiveEditing !== 'function' || !entity.isPerspectiveEditing() || typeof entity.getSourceHandlePoints !== 'function') continue;
      const handles = entity.getSourceHandlePoints();
      for (let index = 0; index < handles.length; index++) {
        const handle = handles[index];
        const dist = Math.hypot(handle.x - wx, handle.y - wy);
        if (dist <= worldTol && dist < bestDist) {
          bestDist = dist;
          best = { image: entity, index };
        }
      }
    }
    return best;
  }

  _findSelectedImageGrid(wx, wy) {
    for (const entity of state.selectedEntities) {
      if (!entity || entity.type !== 'image' || typeof entity.isPerspectiveEditing !== 'function' || !entity.isPerspectiveEditing()) continue;
      const guideQuad = typeof entity.getPerspectiveGuideWorldQuad === 'function'
        ? entity.getPerspectiveGuideWorldQuad()
        : (typeof entity.getSourceHandlePoints === 'function' ? entity.getSourceHandlePoints() : null);
      if (_pointInPolygon(wx, wy, guideQuad)) {
        return { image: entity, index: -1, mode: 'grid' };
      }
    }
    return null;
  }

  _getPerspectiveEditingImage() {
    return (state.scene?.images || []).find((entity) => entity && typeof entity.isPerspectiveEditing === 'function' && entity.isPerspectiveEditing()) || null;
  }

  _ensurePerspectiveEditingImageSelected(image) {
    if (!image) return;
    for (const entity of [...state.selectedEntities]) {
      if (entity !== image) state.deselect(entity);
    }
    if (!image.selected) state.select(image);
  }

  // ------------------------------------------------------------------
  //  Snap-to-coincidence helpers
  // ------------------------------------------------------------------

  /**
   * Find snap-to-coincidence candidates for a set of dragged points.
   * For each dragged point, find the closest non-connected scene point within
   * snap tolerance. Returns array of {dragPt, targetPt, x, y}.
   * Each target point is only used once (closest drag point wins).
   */
  _findSnapCandidates(dragPts) {
    const snapTol = PICK_PT_PX / this._effectiveZoom();
    const scene = state.scene;
    const dragSet = new Set(dragPts);

    // Build exclusion set: points connected to any dragged point
    const excluded = new Set(dragPts);
    for (const dp of dragPts) {
      for (const s of scene.segments) {
        if (s.p1 === dp) excluded.add(s.p2);
        if (s.p2 === dp) excluded.add(s.p1);
      }
      for (const c of scene.constraints) {
        if (c.type === 'coincident') {
          if (c.ptA === dp) excluded.add(c.ptB);
          if (c.ptB === dp) excluded.add(c.ptA);
        }
      }
    }

    // For each dragged point find the best target
    const candidates = [];
    const usedTargets = new Set();
    for (const dp of dragPts) {
      let bestDist = Infinity;
      let bestTarget = null;
      for (const p of scene.points) {
        if (excluded.has(p) || usedTargets.has(p)) continue;
        const d = Math.hypot(p.x - dp.x, p.y - dp.y);
        if (d < snapTol && d < bestDist) {
          bestDist = d;
          bestTarget = p;
        }
      }
      if (bestTarget) {
        candidates.push({ dragPt: dp, targetPt: bestTarget, x: bestTarget.x, y: bestTarget.y });
        usedTargets.add(bestTarget);
      }
    }
    return candidates;
  }

  /** Apply all snap candidates — merge each drag point into its target. */
  _applySnapCandidates() {
    if (this._snapCandidates.length === 0) return;
    const scene = state.scene;
    for (const c of this._snapCandidates) {
      // Verify both points still exist (union may have removed some)
      if (scene.points.includes(c.dragPt) && scene.points.includes(c.targetPt)) {
        union(scene, c.dragPt, c.targetPt);
      }
    }
    this._snapCandidates = [];
  }

  /**
   * Find point-to-line snap candidates for dragged points.
   * Only activates if the point is NOT already snapping to a coincident point.
   * Returns array of {dragPt, seg, x, y} where (x,y) is the projection.
   */
  _findLineSnapCandidates(dragPts) {
    const snapTol = PICK_PX / this._effectiveZoom();
    const scene = state.scene;
    const dragSet = new Set(dragPts);
    // Points that already have a coincident snap — skip line snap for those
    const coincidentDragPts = new Set(this._snapCandidates.map(c => c.dragPt));

    const candidates = [];
    for (const dp of dragPts) {
      if (coincidentDragPts.has(dp)) continue;
      // Check if already on-line constrained to a segment
      const alreadyOnLine = scene.constraints.some(c =>
        c.type === 'on_line' && c.pt === dp
      );
      if (alreadyOnLine) continue;

      let bestDist = Infinity;
      let bestShape = null;
      let bestKind = null;
      let bestX = 0, bestY = 0;
      for (const seg of scene.segments) {
        // Skip segments that own this point
        if (seg.p1 === dp || seg.p2 === dp) continue;
        const d = seg.distanceTo(dp.x, dp.y);
        if (d < snapTol && d < bestDist) {
          // Compute projection onto segment
          const dx = seg.x2 - seg.x1, dy = seg.y2 - seg.y1;
          const lenSq = dx * dx + dy * dy;
          if (lenSq < 1e-12) continue;
          let t = ((dp.x - seg.x1) * dx + (dp.y - seg.y1) * dy) / lenSq;
          t = Math.max(0, Math.min(1, t));
          bestX = seg.x1 + t * dx;
          bestY = seg.y1 + t * dy;
          bestDist = d;
          bestShape = seg;
          bestKind = 'line';
        }
      }
      for (const circle of [...(scene.circles || []), ...(scene.arcs || [])]) {
        if (circle.center === dp || circle.startPoint === dp || circle.endPoint === dp) continue;
        const d = circle.distanceTo(dp.x, dp.y);
        if (d < snapTol && d < bestDist) {
          const angle = Math.atan2(dp.y - circle.cy, dp.x - circle.cx);
          bestX = circle.cx + Math.cos(angle) * circle.radius;
          bestY = circle.cy + Math.sin(angle) * circle.radius;
          bestDist = d;
          bestShape = circle;
          bestKind = 'circle';
        }
      }
      if (bestShape) {
        candidates.push({ dragPt: dp, shape: bestShape, x: bestX, y: bestY, kind: bestKind });
      }
    }
    return candidates;
  }

  /** Apply line snap candidates — add OnLine constraints. */
  _applyLineSnapCandidates() {
    if (this._lineSnapCandidates.length === 0) return;
    const scene = state.scene;
    for (const c of this._lineSnapCandidates) {
      if (scene.points.includes(c.dragPt) && c.kind === 'line' && scene.segments.includes(c.shape)) {
        c.dragPt.x = c.x;
        c.dragPt.y = c.y;
        const constraint = new OnLine(c.dragPt, c.shape);
        scene.addConstraint(constraint);
      } else if (scene.points.includes(c.dragPt) && c.kind === 'circle' && (scene.circles.includes(c.shape) || scene.arcs.includes(c.shape))) {
        c.dragPt.x = c.x;
        c.dragPt.y = c.y;
        const constraint = new OnCircle(c.dragPt, c.shape);
        scene.addConstraint(constraint);
      }
    }
    this._lineSnapCandidates = [];
  }

  /**
   * Find horizontal/vertical alignment guides for dragged points.
   * Returns array of {axis, dragPt, matchX, matchY, value}.
   * Only visual — no constraints applied.
   */
  _findAlignmentGuides(dragPts) {
    const alignTol = ALIGN_TOL_PX / this._effectiveZoom();
    const scene = state.scene;
    const dragSet = new Set(dragPts);
    const guides = [];
    const seenH = new Set(); // avoid duplicate guides for same Y value
    const seenV = new Set(); // avoid duplicate guides for same X value

    for (const dp of dragPts) {
      for (const p of scene.points) {
        if (dragSet.has(p)) continue;
        // Horizontal alignment (same Y)
        const dy = Math.abs(p.y - dp.y);
        if (dy < alignTol && dy > 1e-9) {
          const key = `h_${dp.id}_${Math.round(p.y * 1000)}`;
          if (!seenH.has(key)) {
            seenH.add(key);
            guides.push({ axis: 'h', dragPt: dp, matchX: p.x, matchY: p.y, value: p.y });
          }
        }
        // Vertical alignment (same X)
        const dx = Math.abs(p.x - dp.x);
        if (dx < alignTol && dx > 1e-9) {
          const key = `v_${dp.id}_${Math.round(p.x * 1000)}`;
          if (!seenV.has(key)) {
            seenV.add(key);
            guides.push({ axis: 'v', dragPt: dp, matchX: p.x, matchY: p.y, value: p.x });
          }
        }
      }
    }
    return guides;
  }

  // ------------------------------------------------------------------
  //  Events
  // ------------------------------------------------------------------

  onClick(wx, wy, event) {
    // If we just finished a drag, suppress the click
    if (this._dragPoint || this._dragShape || this._dragDimension || this._dragImageHandle) return;
    if (this._isDragging) return;

    const perspectiveImage = this._getPerspectiveEditingImage();
    if (perspectiveImage) {
      this._ensurePerspectiveEditingImageSelected(perspectiveImage);
      this.setStatus('Finish the active perspective edit first. Apply or Cancel it in Properties.');
      return;
    }

    const hit = this._hitTest(wx, wy);

    if (!event.shiftKey) {
      state.clearSelection();
    }

    if (hit) {
      const t = hit.target;
      if (event.shiftKey && t.selected) {
        state.deselect(t);
      } else {
        state.select(t);
      }
    }
  }

  onMouseDown(wx, wy, sx, sy, event) {
    if (event.button !== 0) return;

    const imageHandle = this._findSelectedImageHandle(wx, wy, PICK_PT_PX) || this._findSelectedImageGrid(wx, wy);
    if (imageHandle) {
      this._dragImageHandle = imageHandle;
      this._dragPoint = null;
      this._dragShape = null;
      this._dragShapePts = [];
      this._dragDimension = null;
      this._dragTookSnapshot = false;
      this._isDragging = false;
      this._dragStart = { wx, wy, sx, sy };
      this._dragCancelState = null;
      return;
    }

    const perspectiveImage = this._getPerspectiveEditingImage();
    if (perspectiveImage) {
      this._ensurePerspectiveEditingImageSelected(perspectiveImage);
      this.setStatus('Finish the active perspective edit first. Apply or Cancel it in Properties.');
      return;
    }

    const fc = computeFullyConstrained(state.scene);

    // 1. Point takes priority
    const pt = this._findClosestPoint(wx, wy, PICK_PT_PX);
    if (pt) {
      if (_isFullyConstrained(pt, fc)) {
        // Fully constrained point — allow click-select but not drag
        this._dragStart = { wx, wy, sx, sy };
        this._isDragging = false;
        this._dragPoint = null;
        this._dragShape = null;
        this._dragRadiusShape = null;
        return;
      }
      const arcCenterPts = this._arcCenterDragPoints(pt);
      if (arcCenterPts.length > 1) {
        this._dragShape = state.scene.arcs.find(arc => arc.center === pt) || null;
        this._dragShapePts = arcCenterPts;
        this._dragPoint = null;
        this._dragArcEndpoint = null;
        this._dragRadiusShape = null;
        this._dragImageHandle = null;
        this._dragTookSnapshot = false;
        this._isDragging = false;
        this._dragStart = { wx, wy, sx, sy };
        this._dragCancelState = null;
        return;
      }
      this._dragPoint = pt;
      this._dragArcEndpoint = this._findArcEndpoint(pt);
      this._dragShape = null;
      this._dragShapePts = [];
      this._dragRadiusShape = null;
      this._dragTookSnapshot = false;
      this._isDragging = false;
      this._dragStart = { wx, wy, sx, sy };
      this._dragCancelState = null;
      return;
    }

    // 2. Dimension drag — reposition offset
    const entity = this._findClosestEntity(wx, wy, PICK_PX);
    if (entity && entity.type === 'dimension') {
      this._dragDimension = entity;
      this._dragPoint = null;
      this._dragShape = null;
      this._dragShapePts = [];
      this._dragTookSnapshot = false;
      this._isDragging = false;
      this._dragStart = { wx, wy, sx, sy };
      this._dragCancelState = null;
      return;
    }

    // 3. Shape drag (segment / circle / arc / image)
    const shape = entity;
    if (shape && !_isFullyConstrained(shape, fc)) {
      if (shape.type === 'circle' || shape.type === 'arc') {
        this._dragRadiusShape = shape;
        this._dragShape = null;
        this._dragShapePts = [];
        this._dragPoint = null;
        this._dragArcEndpoint = null;
        this._dragImageHandle = null;
        this._dragTookSnapshot = false;
        this._isDragging = false;
        this._dragStart = { wx, wy, sx, sy };
        this._dragCancelState = null;
        return;
      }
      const movable = _shapePoints(shape).filter(p => !p.fixed);
      const canTranslateDirectly = (shape.type === 'image' || shape.type === 'group') && typeof shape.translate === 'function';
      if (movable.length > 0 || canTranslateDirectly) {
        this._dragShape = shape;
        this._dragShapePts = movable;
        this._dragPoint = null;
        this._dragImageHandle = null;
        this._dragRadiusShape = null;
        this._dragTookSnapshot = false;
        this._isDragging = false;
        this._dragStart = { wx, wy, sx, sy };
        this._dragCancelState = null;
        return;
      }
    }

    // 4. Default — box select / click-select
    this._dragStart = { wx, wy, sx, sy };
    this._isDragging = false;
    this._dragPoint = null;
    this._dragShape = null;
    this._dragShapePts = [];
    this._dragRadiusShape = null;
    this._dragImageHandle = null;
    this._dragDimension = null;
    this._dragCancelState = null;
  }

  onMouseMove(wx, wy, sx, sy) {
    // ---- Image handle drag in progress ----
    if (this._dragImageHandle && this._dragStart) {
      const dx = sx - this._dragStart.sx;
      const dy = sy - this._dragStart.sy;
      if (!this._isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        this._isDragging = true;
        this._captureImageHandleDragState(this._dragImageHandle.image);
      }
      if (this._isDragging) {
        const { image, index, mode } = this._dragImageHandle;
        if (mode === 'grid' && typeof image.translatePerspectiveDraftWorld === 'function') {
          image.translatePerspectiveDraftWorld(wx - this._dragStart.wx, wy - this._dragStart.wy);
          this._dragStart.wx = wx;
          this._dragStart.wy = wy;
        } else if (typeof image.setPerspectiveDraftHandleWorldPoint === 'function') {
          image.setPerspectiveDraftHandleWorldPoint(index, wx, wy);
        } else {
          const uv = image.worldToNormalized(wx, wy);
          image.setPerspectiveDraftPoint(index, uv.u, uv.v);
        }
        state.emit('change');
      }
      return;
    }

    // ---- Vertex drag in progress ----
    if (this._dragPoint && this._dragStart) {
      const dx = sx - this._dragStart.sx;
      const dy = sy - this._dragStart.sy;
      if (!this._isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        this._isDragging = true;
        this._captureSceneDragState();
        if (!this._dragTookSnapshot) { takeSnapshot(); this._dragTookSnapshot = true; }
        this._beginConstrainedDragIfNeeded();
      }
      if (this._isDragging) {
        if (this._dragArcEndpoint) this._applyDraggedArcEndpointTarget(wx, wy);
        else this._applyDraggedPointTarget(wx, wy);
        this._queueIdleDragSettle(wx, wy);
      }
      return;
    }

    // ---- Dimension drag in progress ----
    if (this._dragDimension && this._dragStart) {
      const dx = sx - this._dragStart.sx;
      const dy = sy - this._dragStart.sy;
      if (!this._isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        this._isDragging = true;
        this._captureSceneDragState();
        if (!this._dragTookSnapshot) { takeSnapshot(); this._dragTookSnapshot = true; }
      }
      if (this._isDragging) {
        this._dragDimension.offset = this._computeDimOffset(this._dragDimension, wx, wy);
        state.emit('change');
      }
      return;
    }

    // ---- Circle / arc edge radius drag in progress ----
    if (this._dragRadiusShape && this._dragStart) {
      const dx = sx - this._dragStart.sx;
      const dy = sy - this._dragStart.sy;
      if (!this._isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        this._isDragging = true;
        this._captureSceneDragState();
        if (!this._dragTookSnapshot) { takeSnapshot(); this._dragTookSnapshot = true; }
        this._beginConstrainedDragIfNeeded();
      }
      if (this._isDragging) {
        this._applyDraggedRadiusTarget(wx, wy);
        this._queueIdleDragSettle(wx, wy);
      }
      return;
    }

    // ---- Shape drag in progress ----
    if (this._dragShape && this._dragStart) {
      const dx = sx - this._dragStart.sx;
      const dy = sy - this._dragStart.sy;
      if (!this._isDragging && (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD)) {
        this._isDragging = true;
        this._captureSceneDragState();
        if (!this._dragTookSnapshot) { takeSnapshot(); this._dragTookSnapshot = true; }
        this._beginConstrainedDragIfNeeded();
      }
      if (this._isDragging) {
        this._applyDraggedShapeTarget(wx, wy);
        this._queueIdleDragSettle(wx, wy);
      }
      return;
    }

    // ---- Box-select drag ----
    if (this._dragStart) {
      const dx = sx - this._dragStart.sx;
      const dy = sy - this._dragStart.sy;
      if (Math.abs(dx) > DRAG_THRESHOLD || Math.abs(dy) > DRAG_THRESHOLD) {
        this._isDragging = true;
        this._selectionBox = {
          x1: this._dragStart.wx,
          y1: this._dragStart.wy,
          x2: wx,
          y2: wy,
        };
      }
      this.app.renderer.hoverEntity = null;
      return;
    }

    // ---- Hover highlight ----
    const hit = this._hitTest(wx, wy);
    this.app.renderer.hoverEntity = hit ? hit.target : null;
  }

  onMouseUp(wx, wy, event) {
    this._clearDragSettle();
    // ---- Finish image handle drag ----
    if (this._dragImageHandle) {
      if (this._isDragging) {
        state.emit('change');
      }
      this._dragImageHandle = null;
      this._isDragging = false;
      this._dragStart = null;
      this._dragTookSnapshot = false;
      this._dragCancelState = null;
      return;
    }

    // ---- Finish vertex drag ----
    if (this._dragPoint) {
      if (this._isDragging) {
        // Recompute snap candidates at the drag point's current position
        // to guard against stale data from deferred mouse processing.
        if (state.autoCoincidence) {
          this._snapCandidates = this._findSnapCandidates([this._dragPoint]);
          this._lineSnapCandidates = this._findLineSnapCandidates([this._dragPoint]);
        }
        this._applySnapCandidates();
        this._applyLineSnapCandidates();
        state.scene.solve(LIVE_DRAG_SOLVE_OPTIONS);
        state.emit('change');
      }
      this._dragPoint = null;
      this._dragArcEndpoint = null;
      this._snapCandidates = [];
      this._lineSnapCandidates = [];
      this._alignmentGuides = [];
      this._isDragging = false;
      this._dragStart = null;
      this._dragTookSnapshot = false;
      this._dragCancelState = null;
      return;
    }

    // ---- Finish circle / arc radius drag ----
    if (this._dragRadiusShape) {
      if (this._isDragging) {
        if (this._dragRadiusShape.type === 'arc' && state.autoCoincidence) {
          const arcPts = [this._dragRadiusShape.startPoint, this._dragRadiusShape.endPoint].filter(Boolean);
          this._snapCandidates = this._findSnapCandidates(arcPts);
          this._lineSnapCandidates = this._findLineSnapCandidates(arcPts);
        }
        this._applySnapCandidates();
        this._applyLineSnapCandidates();
        state.scene.solve(LIVE_DRAG_SOLVE_OPTIONS);
        state.emit('change');
      }
      this._dragRadiusShape = null;
      this._snapCandidates = [];
      this._lineSnapCandidates = [];
      this._alignmentGuides = [];
      this._isDragging = false;
      this._dragStart = null;
      this._dragTookSnapshot = false;
      this._dragCancelState = null;
      return;
    }

    // ---- Finish dimension drag ----
    if (this._dragDimension) {
      if (this._isDragging) {
        state.emit('change');
      }
      this._dragDimension = null;
      this._isDragging = false;
      this._dragStart = null;
      this._dragTookSnapshot = false;
      this._dragCancelState = null;
      return;
    }

    // ---- Finish shape drag ----
    if (this._dragShape) {
      if (this._isDragging) {
        if (this._dragShapePts.length > 0) {
          if (state.autoCoincidence) {
            this._snapCandidates = this._findSnapCandidates(this._dragShapePts);
            this._lineSnapCandidates = this._findLineSnapCandidates(this._dragShapePts);
          }
          this._applySnapCandidates();
          this._applyLineSnapCandidates();
          state.scene.solve(LIVE_DRAG_SOLVE_OPTIONS);
        }
        state.emit('change');
      }
      this._dragShape = null;
      this._dragShapePts = [];
      this._snapCandidates = [];
      this._lineSnapCandidates = [];
      this._alignmentGuides = [];
      this._isDragging = false;
      this._dragStart = null;
      this._dragTookSnapshot = false;
      this._dragCancelState = null;
      return;
    }

    // ---- Finish box selection ----
    if (this._isDragging && this._selectionBox) {
      const box = this._selectionBox;
      const minX = Math.min(box.x1, box.x2);
      const maxX = Math.max(box.x1, box.x2);
      const minY = Math.min(box.y1, box.y2);
      const maxY = Math.max(box.y1, box.y2);

      // If dragging left-to-right => window select (fully inside)
      // If right-to-left => crossing select (any intersection)
      const isWindow = box.x2 > box.x1;

      if (!event.shiftKey) state.clearSelection();

      const selectedGroups = new Set();
      for (const entity of state.entities) {
        if (!entity.visible || !state.isLayerVisible(entity.layer)) continue;
        const parentGroup = this.app?._activeGroupEditId == null
          ? state.scene.groupForPrimitive(entity, null)
          : null;
        const b = entity.getBounds();
        if (isWindow) {
          if (b.minX >= minX && b.maxX <= maxX && b.minY >= minY && b.maxY <= maxY) {
            if (parentGroup) selectedGroups.add(parentGroup);
            else state.select(entity);
          }
        } else {
          if (b.maxX >= minX && b.minX <= maxX && b.maxY >= minY && b.minY <= maxY) {
            if (parentGroup) selectedGroups.add(parentGroup);
            else state.select(entity);
          }
        }
      }
      for (const group of selectedGroups) state.select(group);
    }
    this._dragStart = null;
    this._isDragging = false;
    this._selectionBox = null;
    this._dragCancelState = null;

    // Refresh hover
    const hit = this._hitTest(wx, wy);
    this.app.renderer.hoverEntity = hit ? hit.target : null;
  }

  onCancel() {
    if (this._cancelActiveDrag()) return;
    super.onCancel();
  }

  onKeyDown(event) {
    if (event.key === 'Escape' && this._cancelActiveDrag()) {
      event.preventDefault();
      return true;
    }
    return false;
  }

  /** Compute new offset for a dimension based on world mouse position. */
  _computeDimOffset(dim, wx, wy) {
    if (dim.dimType === 'angle') {
      // Offset = distance from vertex to mouse
      return Math.hypot(wx - dim.x1, wy - dim.y1) || 10;
    }
    if (dim.dimType === 'dx') {
      // Offset moves the horizontal dim line vertically
      return (wy - dim.y1) || 10;
    }
    if (dim.dimType === 'dy') {
      // Offset moves the vertical dim line horizontally
      return (wx - dim.x1) || 10;
    }
    // Linear: perpendicular projection onto the dimension baseline normal
    const dx = dim.x2 - dim.x1, dy = dim.y2 - dim.y1;
    const len = Math.hypot(dx, dy) || 1e-9;
    const nx = -dy / len, ny = dx / len;
    const dot = (wx - dim.x1) * nx + (wy - dim.y1) * ny;
    return dot || 10;
  }

  /** Render the selection box overlay */
  drawOverlay(ctx, vp) {
    // --- Coincidence snap indicators ---
    if (this._snapCandidates.length > 0 && this._isDragging) {
      ctx.save();
      for (const cand of this._snapCandidates) {
        const s = vp.worldToScreen(cand.x, cand.y);
        const r = 8;
        // Outer circle
        ctx.strokeStyle = '#00e676';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.stroke();
        // Inner dot
        ctx.fillStyle = '#00e676';
        ctx.beginPath();
        ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
        ctx.fill();
        // "Coincident" label
        ctx.font = '10px Consolas, monospace';
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(0,230,118,0.85)';
        ctx.fillText('\u2299 Coincident', s.x + r + 4, s.y - 2);
      }
      ctx.restore();
    }

    // --- On-line snap indicators ---
    if (this._lineSnapCandidates.length > 0 && this._isDragging) {
      ctx.save();
      for (const cand of this._lineSnapCandidates) {
        const s = vp.worldToScreen(cand.x, cand.y);
        const r = 8;
        // Draw a small "X" on the line
        ctx.strokeStyle = '#ff9800';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(s.x - r * 0.6, s.y - r * 0.6);
        ctx.lineTo(s.x + r * 0.6, s.y + r * 0.6);
        ctx.moveTo(s.x + r * 0.6, s.y - r * 0.6);
        ctx.lineTo(s.x - r * 0.6, s.y + r * 0.6);
        ctx.stroke();
        // Circle around it
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.stroke();
        // "On Line" label
        ctx.font = '10px Consolas, monospace';
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';
        ctx.fillStyle = 'rgba(255,152,0,0.85)';
        ctx.fillText('\u2295 On Line', s.x + r + 4, s.y - 2);
      }
      ctx.restore();
    }

    // --- Alignment guides (thin dashed lines) ---
    if (this._alignmentGuides.length > 0 && this._isDragging) {
      ctx.save();
      ctx.strokeStyle = 'rgba(0,200,255,0.45)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([6, 4]);
      const cw = ctx.canvas.width;
      const ch = ctx.canvas.height;
      for (const g of this._alignmentGuides) {
        if (g.axis === 'h') {
          // Horizontal guide at y = g.value
          const sy = vp.worldToScreen(0, g.value).y;
          ctx.beginPath();
          ctx.moveTo(0, sy);
          ctx.lineTo(cw, sy);
          ctx.stroke();
          // Small diamond at the matched point
          const ms = vp.worldToScreen(g.matchX, g.matchY);
          ctx.fillStyle = 'rgba(0,200,255,0.6)';
          ctx.beginPath();
          ctx.moveTo(ms.x, ms.y - 4);
          ctx.lineTo(ms.x + 4, ms.y);
          ctx.lineTo(ms.x, ms.y + 4);
          ctx.lineTo(ms.x - 4, ms.y);
          ctx.closePath();
          ctx.fill();
        } else {
          // Vertical guide at x = g.value
          const sx = vp.worldToScreen(g.value, 0).x;
          ctx.beginPath();
          ctx.moveTo(sx, 0);
          ctx.lineTo(sx, ch);
          ctx.stroke();
          // Small diamond at the matched point
          const ms = vp.worldToScreen(g.matchX, g.matchY);
          ctx.fillStyle = 'rgba(0,200,255,0.6)';
          ctx.beginPath();
          ctx.moveTo(ms.x, ms.y - 4);
          ctx.lineTo(ms.x + 4, ms.y);
          ctx.lineTo(ms.x, ms.y + 4);
          ctx.lineTo(ms.x - 4, ms.y);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }

    if (!this._isDragging || !this._selectionBox) return;
    const box = this._selectionBox;
    const p1 = vp.worldToScreen(box.x1, box.y1);
    const p2 = vp.worldToScreen(box.x2, box.y2);
    const x = Math.min(p1.x, p2.x);
    const y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x);
    const h = Math.abs(p2.y - p1.y);

    ctx.save();
    const isWindow = box.x2 > box.x1;
    if (isWindow) {
      ctx.fillStyle = 'rgba(0,100,255,0.1)';
      ctx.strokeStyle = 'rgba(0,100,255,0.6)';
      ctx.setLineDash([]);
    } else {
      ctx.fillStyle = 'rgba(0,200,100,0.1)';
      ctx.strokeStyle = 'rgba(0,200,100,0.6)';
      ctx.setLineDash([6, 4]);
    }
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
    ctx.restore();
  }
}

// js/tools/DimensionTool.js — Smart constraint dimension tool
//
// Click between any two primitives (or a single line/arc) and the tool
// automatically detects the appropriate dimension type:
//   - Two parallel lines → distance between them
//   - Two non-parallel lines → angle between them
//   - Two points → distance (dx, dy available via prompt)
//   - Point + line → perpendicular distance
//   - Arcs/circles → distance from center
//   - Single line → length   |   Single arc/circle → radius
//
// After selecting two entities the user moves the mouse to set the offset
// distance of the dimension annotation, then clicks to place it.
// A prompt asks whether the dimension is a constraint or following,
// optional variable name, and display mode.

import { BaseTool } from './BaseTool.js';
import { DimensionPrimitive, detectDimensionType } from '../cad/DimensionPrimitive.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { showDimensionInput, dismissDimensionInput } from '../ui/popup.js';
import { setVariable } from '../cad/Constraint.js';

export class DimensionTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'dimension';
    this._firstEntity = null;
    this._dimInfo = null; // result from detectDimensionType
    this._previewDim = null;
  }

  activate() {
    super.activate();
    this._firstEntity = null;
    this._dimInfo = null;
    this._previewDim = null;
    this.setStatus('Smart Dimension: Click first entity (point, line, arc, circle)');
  }

  deactivate() {
    this._firstEntity = null;
    this._dimInfo = null;
    this._previewDim = null;
    this.app.renderer.hoverEntity = null;
    super.deactivate();
  }

  _findEntity(wx, wy) {
    const tol = 12 / this.app.viewport.zoom;
    // Try closest point first
    const pt = state.scene.findClosestPoint(wx, wy, tol);
    if (pt) return pt;
    // Then closest shape (segment, circle, arc)
    const shape = state.scene.findClosestShape(wx, wy, tol);
    if (shape && shape.type !== 'text' && shape.type !== 'dimension') return shape;
    return null;
  }

  onMouseMove(wx, wy) {
    if (this.step === 0 || this.step === 1) {
      // Highlight entity under cursor
      const entity = this._findEntity(wx, wy);
      this.app.renderer.hoverEntity = entity;
    }
    if (this.step === 2 && this._dimInfo) {
      // User is positioning the offset
      const offset = this._computeOffset(wx, wy);
      const dim = this._buildDimension(offset);
      this.app.renderer.previewEntities = dim ? [dim] : [];
    }
  }

  async onClick(wx, wy) {
    if (this.step === 0) {
      // Pick first entity
      const entity = this._findEntity(wx, wy);
      if (!entity) {
        this.setStatus('Smart Dimension: No entity found — click closer');
        return;
      }
      this._firstEntity = entity;

      // Check if single entity can produce a dimension by itself
      const singleDim = detectDimensionType(entity, null);
      if (singleDim && (entity.type === 'segment' || entity.type === 'circle' || entity.type === 'arc')) {
        // Allow single-entity dimension — proceed to offset step
        this._dimInfo = { ...singleDim, sourceA: entity, sourceB: null };
        this.step = 2;
        this.setStatus('Smart Dimension: Move mouse to set offset, then click to place');
        return;
      }
      this.step = 1;
      this.setStatus('Smart Dimension: Click second entity');
      return;
    }

    if (this.step === 1) {
      // Pick second entity
      const entity = this._findEntity(wx, wy);
      if (!entity) {
        this.setStatus('Smart Dimension: No entity found — click closer');
        return;
      }
      if (entity === this._firstEntity) {
        // Same entity — if it's a line or arc, create single-entity dim
        const singleDim = detectDimensionType(entity, null);
        if (singleDim) {
          this._dimInfo = { ...singleDim, sourceA: entity, sourceB: null };
          this.step = 2;
          this.setStatus('Smart Dimension: Move mouse to set offset, then click to place');
          return;
        }
        this.setStatus('Smart Dimension: Pick a different entity');
        return;
      }

      const info = detectDimensionType(this._firstEntity, entity);
      if (!info) {
        this.setStatus('Smart Dimension: Cannot create dimension between these entities');
        this._reset();
        return;
      }
      this._dimInfo = { ...info, sourceA: this._firstEntity, sourceB: entity };
      this.step = 2;
      this.setStatus('Smart Dimension: Move mouse to set offset, then click to place');
      return;
    }

    if (this.step === 2) {
      // Place the dimension
      const offset = this._computeOffset(wx, wy);
      const dim = this._buildDimension(offset);
      if (!dim) { this._reset(); return; }

      // Check if there's already a constraint between the involved entities
      const alreadyConstrained = this._isAlreadyConstrained(dim);

      // Compute screen position for the inline widget (midpoint of dimension line)
      const vp = this.app.viewport;
      const midWx = (dim.x1 + dim.x2) / 2;
      const midWy = (dim.y1 + dim.y2) / 2;
      const screenMid = vp.worldToScreen(midWx, midWy);

      const isAngle = dim.dimType === 'angle';
      const currentVal = isAngle
        ? (dim.value * 180 / Math.PI).toFixed(2)
        : dim.value.toFixed(4);

      const result = await showDimensionInput({
        dimType: dim.dimType,
        defaultValue: currentVal,
        driven: alreadyConstrained,
        hint: 'value or variable name',
        screenPos: { x: screenMid.x, y: screenMid.y },
      });

      if (result === null) {
        // Cancelled — still place dimension as non-constraint
        this._reset();
        this.setStatus('Smart Dimension: Cancelled');
        return;
      }

      const { value: inputVal, driven } = result;

      // Parse value — could be numeric, a simple variable name, or a formula expression
      const num = parseFloat(inputVal);
      const isNum = !isNaN(num);
      const trimmed = inputVal.trim();
      // A simple variable name is an identifier (letters/underscore, optionally followed by letters/digits/underscore)
      const isSimpleVar = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed);
      const isFormula = !isNum && !isSimpleVar && trimmed.length > 0;

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
        dim.formula = dim.dimType === 'angle' ? (num * Math.PI / 180) : num;
        dim.variableName = null;
      }

      takeSnapshot();
      dim.layer = state.activeLayer;
      state.scene.dimensions.push(dim);

      // If not driven (i.e. constraining), add dimension directly as a solver constraint
      if (!driven && dim.sourceA) {
        state.scene.addConstraint(dim);
      }

      state.emit('change');

      this._reset();
      this.setStatus('Smart Dimension: Click first entity for next dimension');
    }
  }

  /** Check if the two source entities already have a distance/angle constraint between them. */
  _isAlreadyConstrained(dim) {
    const scene = state.scene;
    const srcA = dim.sourceAId != null ? this._findPrimById(dim.sourceAId) : null;
    const srcB = dim.sourceBId != null ? this._findPrimById(dim.sourceBId) : null;
    if (!srcA) return false;
    const consts = scene.constraintsOn(srcA);
    if (!srcB) {
      // Single entity — check for length/radius constraint
      return consts.some(c => c.type === 'length' || c.type === 'radius' || (c.type === 'dimension' && c.isConstraint));
    }
    const constsB = scene.constraintsOn(srcB);
    const ids = new Set(consts.map(c => c.id));
    return constsB.some(c => ids.has(c.id));
  }

  _findPrimById(id) {
    for (const s of state.scene.shapes()) {
      if (s.id === id) return s;
    }
    for (const p of state.scene.points) {
      if (p.id === id) return p;
    }
    return null;
  }

  _computeOffset(wx, wy) {
    if (!this._dimInfo) return 10;
    const info = this._dimInfo;
    if (info.dimType === 'angle') {
      // Offset = distance from vertex to mouse
      return Math.hypot(wx - info.x1, wy - info.y1);
    }
    // Perpendicular distance from dimension line to mouse
    const dx = info.x2 - info.x1, dy = info.y2 - info.y1;
    const len = Math.hypot(dx, dy) || 1e-9;
    const nx = -dy / len, ny = dx / len;
    // Project mouse offset onto normal
    const dot = (wx - info.x1) * nx + (wy - info.y1) * ny;
    return dot || 10;
  }

  _buildDimension(offset) {
    if (!this._dimInfo) return null;
    const info = this._dimInfo;
    const dim = new DimensionPrimitive(info.x1, info.y1, info.x2, info.y2, offset, {
      dimType: info.dimType,
      sourceAId: info.sourceA ? info.sourceA.id : null,
      sourceBId: info.sourceB ? info.sourceB.id : null,
      sourceA: info.sourceA || null,
      sourceB: info.sourceB || null,
    });
    if (info.angleStart != null) dim._angleStart = info.angleStart;
    if (info.angleSweep != null) dim._angleSweep = info.angleSweep;
    return dim;
  }

  _reset() {
    this._firstEntity = null;
    this._dimInfo = null;
    this._previewDim = null;
    this.step = 0;
    this.app.renderer.previewEntities = [];
    this.app.renderer.hoverEntity = null;
  }

  onCancel() {
    this._reset();
    super.onCancel();
    this.setStatus('Smart Dimension: Click first entity');
  }
}

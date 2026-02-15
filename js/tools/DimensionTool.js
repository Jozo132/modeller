// js/tools/DimensionTool.js — Smart constraint dimension tool
//
// Click any primitive (line, circle, arc, point) and the tool automatically
// detects the appropriate dimension type:
//   - Single line → length (alt: ΔX, ΔY)
//   - Single circle/arc → diameter (alt: radius)
//   - Two parallel lines → distance between them
//   - Two non-parallel lines → angle (alt: distance)
//   - Two points → distance (alt: ΔX, ΔY)
//   - Point + line → perpendicular distance
//   - Circles/arcs → distance between centers
//
// During offset placement (step 2), clicking a different entity switches
// to a two-entity dimension, inferring the best type automatically.
// The inline widget shows a type selector when multiple types are possible.

import { BaseTool } from './BaseTool.js';
import { DimensionPrimitive, detectAllDimensionTypes } from '../cad/DimensionPrimitive.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { showDimensionInput, dismissDimensionInput } from '../ui/popup.js';
import { setVariable } from '../cad/Constraint.js';

export class DimensionTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'dimension';
    this._firstEntity = null;
    this._secondEntity = null;
    this._dimInfo = null;        // current selected dim info
    this._allDimInfos = [];      // all possible dim types for current pair
    this._selectedTypeIdx = 0;   // index into _allDimInfos
    this._previewDim = null;
    this._lastOffset = 10;
  }

  activate() {
    super.activate();
    this._reset();
    this.setStatus('Smart Dimension: Click an entity (line, circle, arc, point)');
  }

  deactivate() {
    this._reset();
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

  /** Update available dimension types and select the default */
  _updateDimInfos(entityA, entityB) {
    this._allDimInfos = detectAllDimensionTypes(entityA, entityB || null);
    this._selectedTypeIdx = 0;
    if (this._allDimInfos.length > 0) {
      const info = this._allDimInfos[0];
      this._dimInfo = { ...info, sourceA: entityA, sourceB: entityB || null };
    } else {
      this._dimInfo = null;
    }
  }

  /** Switch to a specific dimension type by index */
  _selectDimType(idx) {
    if (idx < 0 || idx >= this._allDimInfos.length) return;
    this._selectedTypeIdx = idx;
    const info = this._allDimInfos[idx];
    this._dimInfo = {
      ...info,
      sourceA: this._firstEntity,
      sourceB: this._secondEntity || null,
    };
  }

  onMouseMove(wx, wy) {
    if (this.step === 0 || this.step === 1) {
      // Highlight entity under cursor
      const entity = this._findEntity(wx, wy);
      this.app.renderer.hoverEntity = entity;
    }
    if (this.step === 2 && this._dimInfo) {
      // Check if mouse is near another entity (for potential second-entity switch)
      const entity = this._findEntity(wx, wy);
      if (entity && entity !== this._firstEntity && entity !== this._secondEntity) {
        this.app.renderer.hoverEntity = entity;
      } else {
        this.app.renderer.hoverEntity = null;
      }

      // User is positioning the offset
      this._lastOffset = this._computeOffset(wx, wy);
      const dim = this._buildDimension(this._lastOffset);
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
      const allTypes = detectAllDimensionTypes(entity, null);
      if (allTypes.length > 0 && (entity.type === 'segment' || entity.type === 'circle' || entity.type === 'arc')) {
        // Single-entity dimension — proceed to offset step
        this._allDimInfos = allTypes;
        this._selectedTypeIdx = 0;
        this._dimInfo = { ...allTypes[0], sourceA: entity, sourceB: null };
        this.step = 2;
        this.setStatus(`Smart Dimension [${allTypes[0].label}]: Move to set offset, click to place. Click another entity to dimension between them.`);
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
        // Same entity — if it's a line or arc/circle, create single-entity dim
        const allTypes = detectAllDimensionTypes(entity, null);
        if (allTypes.length > 0) {
          this._allDimInfos = allTypes;
          this._selectedTypeIdx = 0;
          this._dimInfo = { ...allTypes[0], sourceA: entity, sourceB: null };
          this.step = 2;
          this.setStatus(`Smart Dimension [${allTypes[0].label}]: Move to set offset, click to place`);
          return;
        }
        this.setStatus('Smart Dimension: Pick a different entity');
        return;
      }

      this._secondEntity = entity;
      this._updateDimInfos(this._firstEntity, entity);
      if (!this._dimInfo) {
        this.setStatus('Smart Dimension: Cannot create dimension between these entities');
        this._reset();
        return;
      }
      this.step = 2;
      this.setStatus(`Smart Dimension [${this._allDimInfos[0].label}]: Move to set offset, click to place`);
      return;
    }

    if (this.step === 2) {
      // Check if user clicked on a different entity — switch to two-entity mode
      const entity = this._findEntity(wx, wy);
      if (entity && entity !== this._firstEntity && entity !== this._secondEntity) {
        // Switching to a new second entity
        this._secondEntity = entity;
        this._updateDimInfos(this._firstEntity, entity);
        if (!this._dimInfo) {
          this.setStatus('Smart Dimension: Cannot create dimension between these entities');
          return;
        }
        this.setStatus(`Smart Dimension [${this._allDimInfos[0].label}]: Move to set offset, click to place`);
        return;
      }

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

      // Prepare alternate dimension types for the widget
      const alternateTypes = this._allDimInfos.map((info, idx) => ({
        label: info.label,
        dimType: info.dimType,
        selected: idx === this._selectedTypeIdx,
      }));

      const result = await showDimensionInput({
        dimType: dim.dimType,
        defaultValue: currentVal,
        driven: alreadyConstrained,
        hint: 'value or variable name',
        screenPos: { x: screenMid.x, y: screenMid.y },
        alternateTypes: alternateTypes.length > 1 ? alternateTypes : null,
        onTypeChange: (idx) => {
          this._selectDimType(idx);
          // Return the new dim info for the input to update its value
          const newDim = this._buildDimension(offset);
          if (!newDim) return null;
          const newIsAngle = this._allDimInfos[idx].dimType === 'angle';
          return {
            dimType: this._allDimInfos[idx].dimType,
            value: newIsAngle
              ? (newDim.value * 180 / Math.PI).toFixed(2)
              : newDim.value.toFixed(4),
          };
        },
      });

      if (result === null) {
        this._reset();
        this.setStatus('Smart Dimension: Cancelled');
        return;
      }

      // Rebuild dimension with potentially changed type
      const finalDim = this._buildDimension(offset);
      if (!finalDim) { this._reset(); return; }

      const { value: inputVal, driven } = result;

      // Parse value
      const num = parseFloat(inputVal);
      const isNum = !isNaN(num);
      const trimmed = inputVal.trim();
      const isSimpleVar = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(trimmed);
      const isFormula = !isNum && !isSimpleVar && trimmed.length > 0;

      finalDim.isConstraint = !driven;
      finalDim.displayMode = (isSimpleVar || isFormula) ? 'both' : 'value';

      if (isSimpleVar) {
        finalDim.formula = trimmed;
        finalDim.variableName = trimmed;
        setVariable(trimmed, finalDim.value);
      } else if (isFormula) {
        finalDim.formula = trimmed;
        finalDim.variableName = null;
      } else if (isNum) {
        finalDim.formula = finalDim.dimType === 'angle' ? (num * Math.PI / 180) : num;
        finalDim.variableName = null;
      }

      takeSnapshot();
      finalDim.layer = state.activeLayer;
      state.scene.dimensions.push(finalDim);

      if (!driven && finalDim.sourceA) {
        state.scene.addConstraint(finalDim);
      }

      state.emit('change');

      this._reset();
      this.setStatus('Smart Dimension: Click first entity for next dimension');
    }
  }

  /** Check if the two source entities already have a distance/angle constraint. */
  _isAlreadyConstrained(dim) {
    const scene = state.scene;
    const srcA = dim.sourceAId != null ? this._findPrimById(dim.sourceAId) : null;
    const srcB = dim.sourceBId != null ? this._findPrimById(dim.sourceBId) : null;
    if (!srcA) return false;
    const consts = scene.constraintsOn(srcA);
    if (!srcB) {
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
      return Math.hypot(wx - info.x1, wy - info.y1);
    }
    if (info.dimType === 'dx') {
      // Offset moves the horizontal dim line vertically
      return (wy - info.y1) || 10;
    }
    if (info.dimType === 'dy') {
      // Offset moves the vertical dim line horizontally
      return (wx - info.x1) || 10;
    }
    const dx = info.x2 - info.x1, dy = info.y2 - info.y1;
    const len = Math.hypot(dx, dy) || 1e-9;
    const nx = -dy / len, ny = dx / len;
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
    this._secondEntity = null;
    this._dimInfo = null;
    this._allDimInfos = [];
    this._selectedTypeIdx = 0;
    this._previewDim = null;
    this._lastOffset = 10;
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

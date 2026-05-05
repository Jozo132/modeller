import { Primitive } from './Primitive.js';
import {
  applyProjectiveMatrix,
  getQuadToQuadMatrix,
  getUnitSquareToQuadMatrix,
  invertProjectiveMatrix,
  mapUnitSquareToQuadProjective,
} from '../render/projective-quad.js';

const DEFAULT_SOURCE_QUAD = Object.freeze([
  { u: 0, v: 0 },
  { u: 1, v: 0 },
  { u: 1, v: 1 },
  { u: 0, v: 1 },
]);
const MIN_TRANSFORM_SCALE = 1e-9;
const MIN_DIMENSION = 0.01;
const PERSPECTIVE_SOURCE_MARGIN_SCALE = 3;

const DEFAULT_TRACE_SETTINGS = Object.freeze({
  thresholdMode: 'auto',
  threshold: 127,
  thresholdLevels: '',
  invert: false,
  minSpeckArea: 8,
  minArea: 12,
  simplifyTolerance: 1.5,
  curveMode: 'straight',
  fitTolerance: 1.2,
  fitMaxControls: 16,
  detectionMode: 'contour',
  edgeThreshold: 72,
});

function fullSourceQuad() {
  return DEFAULT_SOURCE_QUAD.map((point) => ({ ...point }));
}

function normalizeCellCount(value, fallback = 3) {
  const count = Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(1, count);
}

function quadsEqual(a, b, tolerance = 1e-9) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    if (Math.abs((a[index]?.u ?? 0) - (b[index]?.u ?? 0)) > tolerance) return false;
    if (Math.abs((a[index]?.v ?? 0) - (b[index]?.v ?? 0)) > tolerance) return false;
  }
  return true;
}

function cloneQuad(quad, fallbackWidth, fallbackHeight) {
  if (Array.isArray(quad) && quad.length === 4) {
    return quad.map((point) => ({
      x: Number.isFinite(point?.x) ? point.x : 0,
      y: Number.isFinite(point?.y) ? point.y : 0,
    }));
  }
  return [
    { x: 0, y: 0 },
    { x: fallbackWidth, y: 0 },
    { x: fallbackWidth, y: fallbackHeight },
    { x: 0, y: fallbackHeight },
  ];
}

function cloneOptionalQuad(quad) {
  if (!Array.isArray(quad) || quad.length !== 4) {
    return null;
  }
  return quad.map((point) => ({
    x: Number.isFinite(point?.x) ? point.x : 0,
    y: Number.isFinite(point?.y) ? point.y : 0,
  }));
}

function targetRectQuad(width, height) {
  const targetWidth = Math.max(MIN_DIMENSION, Number.isFinite(width) ? width : 1);
  const targetHeight = Math.max(MIN_DIMENSION, Number.isFinite(height) ? height : 1);
  return [
    { x: 0, y: 0 },
    { x: targetWidth, y: 0 },
    { x: targetWidth, y: targetHeight },
    { x: 0, y: targetHeight },
  ];
}

function cloneCropRect(rect) {
  if (!rect || typeof rect !== 'object') {
    return null;
  }
  const x = Number.isFinite(rect.x) ? rect.x : 0;
  const y = Number.isFinite(rect.y) ? rect.y : 0;
  const width = Number.isFinite(rect.width) ? rect.width : 0;
  const height = Number.isFinite(rect.height) ? rect.height : 0;
  if (width <= 1e-9 || height <= 1e-9) {
    return null;
  }
  return { x, y, width, height };
}

function cloneSourceQuad(quad) {
  if (Array.isArray(quad) && quad.length === 4) {
    return quad.map((point) => ({
      u: Number.isFinite(point?.u) ? point.u : 0,
      v: Number.isFinite(point?.v) ? point.v : 0,
    }));
  }
  return DEFAULT_SOURCE_QUAD.map((point) => ({ ...point }));
}

function expandBounds(bounds, scale = PERSPECTIVE_SOURCE_MARGIN_SCALE) {
  if (!bounds) return bounds;
  const safeScale = Number.isFinite(scale) && scale > 1 ? scale : 1;
  const centerU = (bounds.minU + bounds.maxU) * 0.5;
  const centerV = (bounds.minV + bounds.maxV) * 0.5;
  const halfSpanU = Math.max(1e-9, bounds.spanU * safeScale * 0.5);
  const halfSpanV = Math.max(1e-9, bounds.spanV * safeScale * 0.5);
  return {
    minU: centerU - halfSpanU,
    maxU: centerU + halfSpanU,
    minV: centerV - halfSpanV,
    maxV: centerV + halfSpanV,
    spanU: halfSpanU * 2,
    spanV: halfSpanV * 2,
  };
}

function quadSignedArea(quad) {
  if (!Array.isArray(quad) || quad.length !== 4) return 0;
  let area = 0;
  for (let index = 0; index < quad.length; index++) {
    const current = quad[index];
    const next = quad[(index + 1) % quad.length];
    const x0 = Number.isFinite(current?.x) ? current.x : current?.u;
    const y0 = Number.isFinite(current?.y) ? current.y : current?.v;
    const x1 = Number.isFinite(next?.x) ? next.x : next?.u;
    const y1 = Number.isFinite(next?.y) ? next.y : next?.v;
    if (!Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(x1) || !Number.isFinite(y1)) return 0;
    area += x0 * y1 - x1 * y0;
  }
  return area * 0.5;
}

function _cross2d(a, b, c) {
  const ax = (Number.isFinite(b?.x) ? b.x : b?.u) - (Number.isFinite(a?.x) ? a.x : a?.u);
  const ay = (Number.isFinite(b?.y) ? b.y : b?.v) - (Number.isFinite(a?.y) ? a.y : a?.v);
  const bx = (Number.isFinite(c?.x) ? c.x : c?.u) - (Number.isFinite(a?.x) ? a.x : a?.u);
  const by = (Number.isFinite(c?.y) ? c.y : c?.v) - (Number.isFinite(a?.y) ? a.y : a?.v);
  return ax * by - ay * bx;
}

function isValidPerspectiveQuad(quad, referenceQuad = null) {
  if (!Array.isArray(quad) || quad.length !== 4) return false;
  const area = quadSignedArea(quad);
  if (!Number.isFinite(area) || Math.abs(area) <= 1e-9) return false;
  const areaSign = Math.sign(area);
  for (let index = 0; index < quad.length; index++) {
    const cross = _cross2d(quad[index], quad[(index + 1) % quad.length], quad[(index + 2) % quad.length]);
    if (!Number.isFinite(cross) || Math.abs(cross) <= 1e-9) return false;
    if (Math.sign(cross) !== areaSign) return false;
  }
  if (referenceQuad) {
    const refArea = quadSignedArea(referenceQuad);
    if (Number.isFinite(refArea) && Math.abs(refArea) > 1e-9 && Math.sign(refArea) !== areaSign) {
      return false;
    }
  }
  return true;
}

function cloneTraceSettings(settings) {
  const source = settings && typeof settings === 'object' ? settings : {};
  return {
    thresholdMode: source.thresholdMode === 'manual' ? 'manual' : DEFAULT_TRACE_SETTINGS.thresholdMode,
    threshold: Number.isFinite(source.threshold) ? Math.max(0, Math.min(255, Math.round(source.threshold))) : DEFAULT_TRACE_SETTINGS.threshold,
    thresholdLevels: typeof source.thresholdLevels === 'string' ? source.thresholdLevels : DEFAULT_TRACE_SETTINGS.thresholdLevels,
    invert: source.invert === true,
    minSpeckArea: Number.isFinite(source.minSpeckArea) ? Math.max(0, Math.round(source.minSpeckArea)) : DEFAULT_TRACE_SETTINGS.minSpeckArea,
    minArea: Number.isFinite(source.minArea) ? Math.max(0, source.minArea) : DEFAULT_TRACE_SETTINGS.minArea,
    simplifyTolerance: Number.isFinite(source.simplifyTolerance) ? Math.max(0, source.simplifyTolerance) : DEFAULT_TRACE_SETTINGS.simplifyTolerance,
    curveMode: source.curveMode === 'spline' || source.curveMode === 'hybrid' || source.curveMode === 'fitting' ? source.curveMode : DEFAULT_TRACE_SETTINGS.curveMode,
    fitTolerance: Number.isFinite(source.fitTolerance) ? Math.max(0, source.fitTolerance) : DEFAULT_TRACE_SETTINGS.fitTolerance,
    fitMaxControls: Number.isFinite(source.fitMaxControls) ? Math.max(4, Math.round(source.fitMaxControls)) : DEFAULT_TRACE_SETTINGS.fitMaxControls,
    detectionMode: source.detectionMode === 'edge' ? 'edge' : DEFAULT_TRACE_SETTINGS.detectionMode,
    edgeThreshold: Number.isFinite(source.edgeThreshold) ? Math.max(1, Math.min(255, Math.round(source.edgeThreshold))) : DEFAULT_TRACE_SETTINGS.edgeThreshold,
  };
}

function safeTransformScale(value) {
  return Math.abs(value) > MIN_TRANSFORM_SCALE ? value : 1;
}

function pointInPolygon(px, py, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;
    const intersect = ((yi > py) !== (yj > py))
      && (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + dx * t;
  const qy = ay + dy * t;
  return Math.hypot(px - qx, py - qy);
}

export class ImagePrimitive extends Primitive {
  constructor(dataUrl, x, y, width, height, options = {}) {
    super('image');
    this.dataUrl = dataUrl || '';
    this.name = options.name || 'Reference Image';
    this.mimeType = options.mimeType || 'image/png';
    this.naturalWidth = Number.isFinite(options.naturalWidth) ? options.naturalWidth : 0;
    this.naturalHeight = Number.isFinite(options.naturalHeight) ? options.naturalHeight : 0;
    this.x = Number.isFinite(x) ? x : 0;
    this.y = Number.isFinite(y) ? y : 0;
    this.width = Math.max(1e-6, Number.isFinite(width) ? width : 1);
    this.height = Math.max(1e-6, Number.isFinite(height) ? height : 1);
    this.rotation = Number.isFinite(options.rotation) ? options.rotation : 0;
    this.scaleX = Number.isFinite(options.scaleX) ? options.scaleX : 1;
    this.scaleY = Number.isFinite(options.scaleY) ? options.scaleY : 1;
    this.opacity = Number.isFinite(options.opacity) ? Math.max(0, Math.min(1, options.opacity)) : 0.8;
    this.brightness = Number.isFinite(options.brightness) ? options.brightness : 0;
    this.contrast = Number.isFinite(options.contrast) ? options.contrast : 0;
    this.gamma = Number.isFinite(options.gamma) && options.gamma > 0 ? options.gamma : 1;
    this.quantization = Number.isFinite(options.quantization) ? Math.max(0, Math.round(options.quantization)) : 0;
    this.pinnedBackground = options.pinnedBackground === true;
    this.perspectiveEnabled = options.perspectiveEnabled === true;
    this.gridWidth = Number.isFinite(options.gridWidth) ? options.gridWidth : this.width;
    this.gridHeight = Number.isFinite(options.gridHeight) ? options.gridHeight : this.height;
    this.gridCellsX = normalizeCellCount(options.gridCellsX, 3);
    this.gridCellsY = normalizeCellCount(options.gridCellsY, 3);
    this.quad = cloneQuad(options.quad, this.width, this.height);
    this.sourceQuad = cloneSourceQuad(options.sourceQuad);
    this.cropRect = cloneCropRect(options.cropRect);
    this.traceSettings = cloneTraceSettings(options.traceSettings);
    this.perspectiveEditQuad = cloneOptionalQuad(options.perspectiveEditQuad);
    this.perspectiveOutputQuad = cloneOptionalQuad(options.perspectiveOutputQuad);
    this._perspectiveEditing = false;
    this._perspectiveDraftQuad = null;
    this._perspectiveDraftTargetQuad = null;
    this._perspectiveEditBaseWidth = null;
    this._perspectiveEditBaseHeight = null;
    this._clampCropRectToGrid();
  }

  static fullSourceQuad() {
    return fullSourceQuad();
  }

  static defaultTraceSettings() {
    return cloneTraceSettings(DEFAULT_TRACE_SETTINGS);
  }

  getTraceSettings() {
    return cloneTraceSettings(this.traceSettings);
  }

  setTraceSettings(settings) {
    this.traceSettings = cloneTraceSettings({ ...this.traceSettings, ...(settings || {}) });
  }

  isPerspectiveEditing() {
    return this._perspectiveEditing;
  }

  hasAppliedPerspectiveCorrection() {
    return this.perspectiveEnabled && !quadsEqual(this.sourceQuad, DEFAULT_SOURCE_QUAD);
  }

  isIdentitySourceQuad(quad = this.sourceQuad) {
    return quadsEqual(quad, DEFAULT_SOURCE_QUAD);
  }

  beginPerspectiveEdit() {
    const baseWidth = Math.max(MIN_DIMENSION, this.gridWidth || this.width);
    const baseHeight = Math.max(MIN_DIMENSION, this.gridHeight || this.height);
    this._perspectiveEditing = true;
    this._perspectiveDraftQuad = cloneSourceQuad(this.sourceQuad);
    this._perspectiveEditBaseWidth = baseWidth;
    this._perspectiveEditBaseHeight = baseHeight;
    this._perspectiveDraftTargetQuad = this.hasAppliedPerspectiveCorrection()
      ? (cloneOptionalQuad(this.perspectiveEditQuad) || targetRectQuad(baseWidth, baseHeight))
      : null;
  }

  cancelPerspectiveEdit() {
    this._perspectiveEditing = false;
    this._perspectiveDraftQuad = null;
    this._perspectiveDraftTargetQuad = null;
    this._perspectiveEditBaseWidth = null;
    this._perspectiveEditBaseHeight = null;
  }

  getPerspectiveGuideQuad() {
    if (this._perspectiveEditing && this._perspectiveDraftQuad) {
      return this._perspectiveDraftQuad.map((point) => ({ u: point.u, v: point.v }));
    }
    return cloneSourceQuad(this.sourceQuad);
  }

  getPerspectiveDraftTargetQuad() {
    return cloneOptionalQuad(this._perspectiveDraftTargetQuad);
  }

  setPerspectiveDraftTargetQuad(quad) {
    const nextQuad = cloneOptionalQuad(quad);
    this._perspectiveDraftTargetQuad = isValidPerspectiveQuad(nextQuad, this._perspectiveDraftTargetQuad || targetRectQuad(this.gridWidth || this.width, this.gridHeight || this.height))
      ? nextQuad
      : this._perspectiveDraftTargetQuad;
  }

  getRenderSourceQuad() {
    if (this._perspectiveEditing && this.perspectiveEnabled && this._perspectiveDraftTargetQuad) {
      return cloneSourceQuad(this._perspectiveDraftQuad || this.sourceQuad);
    }
    if (this._perspectiveEditing) {
      return fullSourceQuad();
    }
    if (!this.perspectiveEnabled) {
      return fullSourceQuad();
    }
    if (this.perspectiveOutputQuad) {
      return cloneSourceQuad(this.sourceQuad);
    }
    return cloneSourceQuad(this.sourceQuad);
  }

  getRenderSourceBounds(quad = this.sourceQuad) {
    const bounds = this.getSourceQuadBounds(quad);
    const needsMargin = (this._perspectiveEditing && this.perspectiveEnabled && this._perspectiveDraftTargetQuad)
      || (!!this.perspectiveEnabled && !!this.perspectiveOutputQuad);
    return needsMargin ? expandBounds(bounds, PERSPECTIVE_SOURCE_MARGIN_SCALE) : bounds;
  }

  setPerspectiveDraftPoint(index, u, v) {
    if (!this._perspectiveEditing || !this._perspectiveDraftQuad) {
      this.beginPerspectiveEdit();
    }
    if (index < 0 || index >= this._perspectiveDraftQuad.length) return;
    const candidate = cloneSourceQuad(this._perspectiveDraftQuad);
    candidate[index] = {
      u: Number.isFinite(u) ? u : 0,
      v: Number.isFinite(v) ? v : 0,
    };
    if (isValidPerspectiveQuad(candidate, this._perspectiveDraftQuad || DEFAULT_SOURCE_QUAD)) {
      this._perspectiveDraftQuad = candidate;
    }
  }

  _getTargetRectQuad(width = this.gridWidth || this.width, height = this.gridHeight || this.height) {
    return targetRectQuad(width, height);
  }

  _mapTargetLocalPointToSource(point, options = {}) {
    const targetQuad = cloneOptionalQuad(options.targetQuad)
      || cloneOptionalQuad(this._perspectiveDraftTargetQuad)
      || this._getCurrentPerspectiveOutputQuad();
    const sourceQuad = cloneSourceQuad(options.sourceQuad || this._perspectiveDraftQuad || this.sourceQuad)
      .map((sourcePoint) => ({ x: sourcePoint.u, y: sourcePoint.v }));
    const matrix = targetQuad
      ? getQuadToQuadMatrix(targetQuad, sourceQuad)
      : null;
    const mapped = matrix ? applyProjectiveMatrix(matrix, point.x, point.y) : null;
    return mapped
      ? { u: mapped.x, v: mapped.y }
      : {
        u: point.x / Math.max(MIN_DIMENSION, this.gridWidth || this.width),
        v: point.y / Math.max(MIN_DIMENSION, this.gridHeight || this.height),
      };
  }

  _getCurrentPerspectiveOutputQuad() {
    return this.perspectiveOutputQuad
      ? cloneOptionalQuad(this.perspectiveOutputQuad)
      : this.buildPerspectiveOutputQuad(this.sourceQuad, {
        width: this._perspectiveEditBaseWidth || this.gridWidth || this.width,
        height: this._perspectiveEditBaseHeight || this.gridHeight || this.height,
        targetQuad: this.perspectiveEditQuad,
      });
  }

  _getDraftPerspectiveOutputQuad() {
    if (!this._perspectiveEditing || !this.perspectiveEnabled) return null;
    return cloneOptionalQuad(this._perspectiveDraftTargetQuad)
      || cloneOptionalQuad(this.perspectiveOutputQuad)
      || null;
  }

  worldToLocalPoint(px, py) {
    const dx = px - this.x;
    const dy = py - this.y;
    const angle = (this.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const invX = dx * cos + dy * sin;
    const invY = -dx * sin + dy * cos;
    const scaleX = safeTransformScale(this.scaleX);
    const scaleY = safeTransformScale(this.scaleY);
    return {
      x: invX / scaleX,
      y: invY / scaleY,
    };
  }

  worldVectorToLocal(dx, dy) {
    const angle = (this.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const invX = dx * cos + dy * sin;
    const invY = -dx * sin + dy * cos;
    const scaleX = safeTransformScale(this.scaleX);
    const scaleY = safeTransformScale(this.scaleY);
    return {
      x: invX / scaleX,
      y: invY / scaleY,
    };
  }

  _updateDraftGridSizeFromTargetQuad() {
    if (!this._perspectiveDraftTargetQuad) return;
    const bottom = Math.hypot(
      this._perspectiveDraftTargetQuad[1].x - this._perspectiveDraftTargetQuad[0].x,
      this._perspectiveDraftTargetQuad[1].y - this._perspectiveDraftTargetQuad[0].y,
    );
    const top = Math.hypot(
      this._perspectiveDraftTargetQuad[2].x - this._perspectiveDraftTargetQuad[3].x,
      this._perspectiveDraftTargetQuad[2].y - this._perspectiveDraftTargetQuad[3].y,
    );
    const right = Math.hypot(
      this._perspectiveDraftTargetQuad[2].x - this._perspectiveDraftTargetQuad[1].x,
      this._perspectiveDraftTargetQuad[2].y - this._perspectiveDraftTargetQuad[1].y,
    );
    const left = Math.hypot(
      this._perspectiveDraftTargetQuad[3].x - this._perspectiveDraftTargetQuad[0].x,
      this._perspectiveDraftTargetQuad[3].y - this._perspectiveDraftTargetQuad[0].y,
    );
    this.gridWidth = Math.max(MIN_DIMENSION, (bottom + top) * 0.5);
    this.gridHeight = Math.max(MIN_DIMENSION, (right + left) * 0.5);
  }

  setPerspectiveDraftHandleWorldPoint(index, wx, wy) {
    if (this._perspectiveEditing && this.perspectiveEnabled && this._perspectiveDraftTargetQuad) {
      if (index < 0 || index >= this._perspectiveDraftTargetQuad.length) return;
      const localPoint = this.worldToLocalPoint(wx, wy);
      const nextTargetQuad = cloneOptionalQuad(this._perspectiveDraftTargetQuad) || targetRectQuad(this.gridWidth || this.width, this.gridHeight || this.height);
      nextTargetQuad[index] = localPoint;
      if (!isValidPerspectiveQuad(nextTargetQuad, this._perspectiveDraftTargetQuad)) return;
      if (!this._perspectiveDraftQuad) this._perspectiveDraftQuad = cloneSourceQuad(this.sourceQuad);
      const nextSourceQuad = cloneSourceQuad(this._perspectiveDraftQuad);
      nextSourceQuad[index] = this._mapTargetLocalPointToSource(localPoint, {
        targetQuad: this._perspectiveDraftTargetQuad,
        sourceQuad: this._perspectiveDraftQuad,
      });
      if (!isValidPerspectiveQuad(nextSourceQuad, this._perspectiveDraftQuad || DEFAULT_SOURCE_QUAD)) return;
      this._perspectiveDraftTargetQuad = nextTargetQuad;
      this._perspectiveDraftQuad = nextSourceQuad;
      this._updateDraftGridSizeFromTargetQuad();
      return;
    }
    const uv = this.worldToNormalized(wx, wy);
    this.setPerspectiveDraftPoint(index, uv.u, uv.v);
  }

  translatePerspectiveDraftWorld(dx, dy) {
    if (!this._perspectiveEditing) return;
    if (this.perspectiveEnabled && this._perspectiveDraftTargetQuad) {
      const delta = this.worldVectorToLocal(dx, dy);
      const previousTargetQuad = cloneOptionalQuad(this._perspectiveDraftTargetQuad);
      this._perspectiveDraftTargetQuad = this._perspectiveDraftTargetQuad.map((point) => ({
        x: point.x + delta.x,
        y: point.y + delta.y,
      }));
      if (!this._perspectiveDraftQuad) this._perspectiveDraftQuad = cloneSourceQuad(this.sourceQuad);
      this._perspectiveDraftQuad = this._perspectiveDraftTargetQuad.map((point) => this._mapTargetLocalPointToSource(point, {
        targetQuad: previousTargetQuad,
        sourceQuad: this._perspectiveDraftQuad,
      }));
      return;
    }
    if (!this._perspectiveDraftQuad) this._perspectiveDraftQuad = cloneSourceQuad(this.sourceQuad);
    const localDelta = this.worldVectorToLocal(dx, dy);
    const du = localDelta.x / Math.max(MIN_DIMENSION, this.width);
    const dv = localDelta.y / Math.max(MIN_DIMENSION, this.height);
    this._perspectiveDraftQuad = this._perspectiveDraftQuad.map((point) => ({
      u: point.u + du,
      v: point.v + dv,
    }));
  }

  applyPerspectiveEdit(options = {}) {
    if (!this._perspectiveEditing || !this._perspectiveDraftQuad) return;
    if (!isValidPerspectiveQuad(this._perspectiveDraftQuad, DEFAULT_SOURCE_QUAD)) return;
    const committedProjectedQuad = cloneOptionalQuad(this.perspectiveEditQuad);
    const preserveCommittedProjectedQuad = this.perspectiveEnabled && !!committedProjectedQuad;
    this.sourceQuad = cloneSourceQuad(this._perspectiveDraftQuad);
    this.perspectiveEnabled = !this.isIdentitySourceQuad(this.sourceQuad);
    const targetWidth = Math.max(MIN_DIMENSION, Number.isFinite(options.targetWidth) ? options.targetWidth : (this.gridWidth || this.width));
    const targetHeight = Math.max(MIN_DIMENSION, Number.isFinite(options.targetHeight) ? options.targetHeight : (this.gridHeight || this.height));
    const projectedTargetQuad = this.perspectiveEnabled
      ? (cloneOptionalQuad(this._perspectiveDraftTargetQuad) || targetRectQuad(targetWidth, targetHeight))
      : null;
    if (projectedTargetQuad && !isValidPerspectiveQuad(projectedTargetQuad, targetRectQuad(targetWidth, targetHeight))) return;
    this.gridWidth = targetWidth;
    this.gridHeight = targetHeight;
    if (options.placeOnGrid !== false) {
      this.applyGridFrame({
        width: targetWidth,
        height: targetHeight,
        moveToOrigin: options.moveToOrigin !== false,
      });
    }
    this.perspectiveEditQuad = preserveCommittedProjectedQuad
      ? committedProjectedQuad
      : projectedTargetQuad;
    this.perspectiveOutputQuad = this.perspectiveEnabled
      ? targetRectQuad(targetWidth, targetHeight)
      : null;
    if (!this.perspectiveEnabled) {
      this.cropRect = null;
    }
    this._clampCropRectToGrid();
    this.cancelPerspectiveEdit();
  }

  resetPerspectiveCorrection() {
    this.sourceQuad = fullSourceQuad();
    this.perspectiveEnabled = false;
    this.cropRect = null;
    this.perspectiveEditQuad = null;
    this.perspectiveOutputQuad = null;
    this.cancelPerspectiveEdit();
  }

  applyGridFrame(options = {}) {
    const targetWidth = Math.max(MIN_DIMENSION, Number.isFinite(options.width) ? options.width : (this.gridWidth || this.width));
    const targetHeight = Math.max(MIN_DIMENSION, Number.isFinite(options.height) ? options.height : (this.gridHeight || this.height));
    this.gridWidth = targetWidth;
    this.gridHeight = targetHeight;
    this.width = targetWidth;
    this.height = targetHeight;
    this.rotation = 0;
    this.scaleX = 1;
    this.scaleY = 1;
    if (options.moveToOrigin !== false) {
      this.x = 0;
      this.y = 0;
    }
    this.resetLocalQuad(targetWidth, targetHeight);
    this._clampCropRectToGrid();
  }

  resetLocalQuad(width = this.width, height = this.height) {
    this.quad = cloneQuad(null, width, height);
  }

  getSourceQuadBounds(quad = this.sourceQuad) {
    const points = cloneSourceQuad(quad);
    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    for (const point of points) {
      if (point.u < minU) minU = point.u;
      if (point.u > maxU) maxU = point.u;
      if (point.v < minV) minV = point.v;
      if (point.v > maxV) maxV = point.v;
    }
    return {
      minU,
      maxU,
      minV,
      maxV,
      spanU: Math.max(1e-9, maxU - minU),
      spanV: Math.max(1e-9, maxV - minV),
    };
  }

  normalizeSourceQuadToBounds(quad = this.sourceQuad, bounds = this.getSourceQuadBounds(quad)) {
    const points = cloneSourceQuad(quad);
    return points.map((point) => ({
      u: (point.u - bounds.minU) / bounds.spanU,
      v: (point.v - bounds.minV) / bounds.spanV,
    }));
  }

  buildPerspectiveOutputQuad(quad = this.sourceQuad, options = {}) {
    const targetWidth = Math.max(MIN_DIMENSION, Number.isFinite(options.width) ? options.width : (this.gridWidth || this.width));
    const targetHeight = Math.max(MIN_DIMENSION, Number.isFinite(options.height) ? options.height : (this.gridHeight || this.height));
    const sourceQuad = cloneSourceQuad(quad).map((point) => ({ x: point.u, y: point.v }));
    const targetQuad = cloneOptionalQuad(options.targetQuad) || targetRectQuad(targetWidth, targetHeight);
    const matrix = getQuadToQuadMatrix(sourceQuad, targetQuad);
    if (!matrix) {
      return null;
    }

    return DEFAULT_SOURCE_QUAD.map((point, index) => applyProjectiveMatrix(matrix, point.u, point.v) || targetQuad[index]);
  }

  _clampCropRectToGrid() {
    if (!this.cropRect) return;
    const maxWidth = Math.max(0.01, Number.isFinite(this.gridWidth) ? this.gridWidth : this.width);
    const maxHeight = Math.max(0.01, Number.isFinite(this.gridHeight) ? this.gridHeight : this.height);
    const minX = Math.max(0, Math.min(maxWidth, this.cropRect.x));
    const minY = Math.max(0, Math.min(maxHeight, this.cropRect.y));
    const maxX = Math.max(minX, Math.min(maxWidth, minX + this.cropRect.width));
    const maxY = Math.max(minY, Math.min(maxHeight, minY + this.cropRect.height));
    const width = maxX - minX;
    const height = maxY - minY;
    if (width <= 1e-9 || height <= 1e-9) {
      this.cropRect = null;
      return;
    }
    this.cropRect = { x: minX, y: minY, width, height };
  }

  setCropRect(rect) {
    this.cropRect = cloneCropRect(rect);
    this._clampCropRectToGrid();
  }

  resetCrop() {
    this.cropRect = null;
  }

  getCropRect() {
    if (!this.cropRect) {
      return null;
    }
    if (!this.perspectiveEnabled || this._perspectiveEditing) {
      return null;
    }
    return cloneCropRect(this.cropRect);
  }

  hasCrop() {
    return !!this.getCropRect();
  }

  getCropLocalQuad() {
    const cropRect = this.getCropRect();
    if (!cropRect) {
      return null;
    }
    return [
      { x: cropRect.x, y: cropRect.y },
      { x: cropRect.x + cropRect.width, y: cropRect.y },
      { x: cropRect.x + cropRect.width, y: cropRect.y + cropRect.height },
      { x: cropRect.x, y: cropRect.y + cropRect.height },
    ];
  }

  getWarpLocalQuad() {
    if (this._perspectiveEditing && this.perspectiveEnabled) {
      return cloneOptionalQuad(this.perspectiveEditQuad)
        || this._getDraftPerspectiveOutputQuad()
        || cloneOptionalQuad(this.perspectiveOutputQuad)
        || this.getLocalQuad();
    }
    if (this.perspectiveEnabled && this.perspectiveOutputQuad) {
      return cloneOptionalQuad(this.perspectiveOutputQuad);
    }
    return this.getLocalQuad();
  }

  getDisplayLocalQuad() {
    const cropQuad = this.getCropLocalQuad();
    if (cropQuad) {
      return cropQuad;
    }
    return this.getWarpLocalQuad();
  }

  _getEditingDisplayQuad() {
    return this._perspectiveEditing && this.perspectiveEditQuad
      ? cloneOptionalQuad(this.perspectiveEditQuad)
      : null;
  }

  getLocalQuad() {
    return this.quad.map((point) => ({ x: point.x, y: point.y }));
  }

  _transformLocalQuadToWorld(quad) {
    const angle = (this.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return quad.map((point) => {
      const sx = point.x * this.scaleX;
      const sy = point.y * this.scaleY;
      return {
        x: this.x + sx * cos - sy * sin,
        y: this.y + sx * sin + sy * cos,
      };
    });
  }

  getWorldQuad() {
    return this._transformLocalQuadToWorld(this.getDisplayLocalQuad());
  }

  getWarpWorldQuad() {
    return this._transformLocalQuadToWorld(this.getWarpLocalQuad());
  }

  getCropWorldQuad() {
    const cropQuad = this.getCropLocalQuad();
    return cropQuad ? this._transformLocalQuadToWorld(cropQuad) : null;
  }

  mapLocalPoint(x, y) {
    return this._transformLocalQuadToWorld([{ x, y }])[0];
  }

  mapNormalizedPoint(u, v) {
    const normalizedU = Number.isFinite(u) ? u : 0;
    const normalizedV = Number.isFinite(v) ? v : 0;
    const angle = (this.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const editDisplayQuad = this._getEditingDisplayQuad();
    const localPoint = editDisplayQuad
      ? (mapUnitSquareToQuadProjective(editDisplayQuad, normalizedU, normalizedV) || { x: this.width * normalizedU, y: this.height * normalizedV })
      : { x: this.width * normalizedU, y: this.height * normalizedV };
    const localX = localPoint.x * this.scaleX;
    const localY = localPoint.y * this.scaleY;
    return {
      x: this.x + localX * cos - localY * sin,
      y: this.y + localX * sin + localY * cos,
    };
  }

  worldToNormalized(px, py) {
    const dx = px - this.x;
    const dy = py - this.y;
    const angle = (this.rotation * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const invX = dx * cos + dy * sin;
    const invY = -dx * sin + dy * cos;
    const scaleX = safeTransformScale(this.scaleX);
    const scaleY = safeTransformScale(this.scaleY);
    const localPoint = {
      x: invX / scaleX,
      y: invY / scaleY,
    };
    const editDisplayQuad = this._getEditingDisplayQuad();
    if (editDisplayQuad) {
      const inverseMatrix = invertProjectiveMatrix(getUnitSquareToQuadMatrix(editDisplayQuad));
      const normalizedPoint = inverseMatrix ? applyProjectiveMatrix(inverseMatrix, localPoint.x, localPoint.y) : null;
      if (normalizedPoint) {
        return {
          u: normalizedPoint.x,
          v: normalizedPoint.y,
        };
      }
    }
    return {
      u: localPoint.x / this.width,
      v: localPoint.y / this.height,
    };
  }

  getSourceHandlePoints() {
    return this.getPerspectiveGuideWorldQuad();
  }

  getPerspectiveGuideWorldQuad() {
    if (this._perspectiveEditing && this.perspectiveEnabled && this._perspectiveDraftTargetQuad) {
      return this._transformLocalQuadToWorld(this._perspectiveDraftTargetQuad);
    }
    if (this.perspectiveEnabled && this.perspectiveEditQuad) {
      return this._transformLocalQuadToWorld(this.perspectiveEditQuad);
    }
    return this.getPerspectiveGuideQuad().map((point) => this.mapNormalizedPoint(point.u, point.v));
  }

  getAppliedPerspectiveGuideWorldQuad() {
    if (!this.perspectiveEditQuad) return null;
    return this._transformLocalQuadToWorld(this.perspectiveEditQuad);
  }

  getBounds() {
    const quad = this.getWorldQuad();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of quad) {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
    return { minX, minY, maxX, maxY };
  }

  getSnapPoints() {
    const quad = this.getWorldQuad();
    return [
      { x: this.x, y: this.y, type: 'origin' },
      ...quad.map((point, index) => ({ x: point.x, y: point.y, type: `corner-${index}` })),
    ];
  }

  distanceTo(px, py) {
    const quad = this.getWorldQuad();
    if (pointInPolygon(px, py, quad)) return 0;
    let best = Infinity;
    for (let index = 0; index < quad.length; index++) {
      const a = quad[index];
      const b = quad[(index + 1) % quad.length];
      best = Math.min(best, segmentDistance(px, py, a.x, a.y, b.x, b.y));
    }
    return best;
  }

  translate(dx, dy) {
    this.x += dx;
    this.y += dy;
  }

  serialize() {
    return {
      ...super.serialize(),
      dataUrl: this.dataUrl,
      name: this.name,
      mimeType: this.mimeType,
      naturalWidth: this.naturalWidth,
      naturalHeight: this.naturalHeight,
      x: this.x,
      y: this.y,
      width: this.width,
      height: this.height,
      rotation: this.rotation,
      scaleX: this.scaleX,
      scaleY: this.scaleY,
      visible: this.visible !== false,
      opacity: this.opacity,
      brightness: this.brightness,
      contrast: this.contrast,
      gamma: this.gamma,
      quantization: this.quantization,
      pinnedBackground: this.pinnedBackground,
      perspectiveEnabled: this.perspectiveEnabled,
      gridWidth: this.gridWidth,
      gridHeight: this.gridHeight,
      gridCellsX: this.gridCellsX,
      gridCellsY: this.gridCellsY,
      quad: this.quad.map((point) => ({ x: point.x, y: point.y })),
      cropRect: this.cropRect ? { ...this.cropRect } : null,
      traceSettings: this.getTraceSettings(),
      perspectiveEditQuad: this.perspectiveEditQuad ? this.perspectiveEditQuad.map((point) => ({ x: point.x, y: point.y })) : null,
      perspectiveOutputQuad: this.perspectiveOutputQuad ? this.perspectiveOutputQuad.map((point) => ({ x: point.x, y: point.y })) : null,
      sourceQuad: this.sourceQuad.map((point) => ({ u: point.u, v: point.v })),
    };
  }
}

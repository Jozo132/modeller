import { BaseTool } from './BaseTool.js';
import { state } from '../state.js';
import { takeSnapshot } from '../history.js';
import { traceImageDataContours } from '../image/trace-raster.js';
import { buildFittedTraceEntities, buildHybridTraceEntities } from '../image/trace-fitting.js';

export class TraceImageTool extends BaseTool {
  constructor(app) {
    super(app);
    this.name = 'trace_image';
  }

  activate() {
    super.activate();
    const image = this._getSelectedImage();
    if (!image) {
      this._finish('Trace Image: Select exactly one image first.');
      return;
    }
    if (typeof image.isPerspectiveEditing === 'function' && image.isPerspectiveEditing()) {
      this._finish('Trace Image: Apply or cancel perspective editing before tracing.');
      return;
    }
    const raster = this.app._renderer3d?.buildTraceImageRaster?.(image, { maxRasterSize: 2048 });
    if (!raster?.canvas) {
      this._finish('Trace Image: Image pixels are not ready yet. Try again once the image finishes loading.');
      return;
    }

    const context = raster.canvas.getContext('2d', { willReadFrequently: true }) || raster.canvas.getContext('2d');
    if (!context) {
      this._finish('Trace Image: Failed to read image pixels.');
      return;
    }

    const imageData = context.getImageData(0, 0, raster.canvas.width, raster.canvas.height);
    const traceSettings = typeof image.getTraceSettings === 'function' ? image.getTraceSettings() : (image.traceSettings || {});
    const contours = traceImageDataContours(imageData.data, raster.canvas.width, raster.canvas.height, {
      ...traceSettings,
    });
    if (contours.length === 0) {
      this._finish('Trace Image: No closed contours were found in the selected image.');
      return;
    }

    const layer = image.layer || state.activeLayer;
    const unitPerPixelX = raster.localRect.width / Math.max(1, raster.canvas.width);
    const unitPerPixelY = raster.localRect.height / Math.max(1, raster.canvas.height);
    const minSegmentLength = Math.max(unitPerPixelX, unitPerPixelY) * 0.35;
    const segmentsToCreate = [];
    const splinesToCreate = [];
    for (const contour of contours) {
      const worldPoints = contour.map((point) => this._mapContourPoint(point, raster, image));
      if (traceSettings.curveMode === 'spline') {
        this._collectContourSpline(worldPoints, minSegmentLength, splinesToCreate);
      } else if (traceSettings.curveMode === 'fitting') {
        const fitted = buildFittedTraceEntities(worldPoints, {
          minSegmentLength,
          detectionMode: traceSettings.detectionMode,
          fitTolerance: traceSettings.fitTolerance,
          fitMaxControls: traceSettings.fitMaxControls,
          unitPerPixel: Math.max(unitPerPixelX, unitPerPixelY),
        });
        segmentsToCreate.push(...fitted.segments);
        splinesToCreate.push(...fitted.splines);
      } else if (traceSettings.curveMode === 'hybrid') {
        const fitted = buildHybridTraceEntities(worldPoints, {
          minSegmentLength,
          detectionMode: traceSettings.detectionMode,
          simplifyTolerance: traceSettings.simplifyTolerance,
          unitPerPixel: Math.max(unitPerPixelX, unitPerPixelY),
        });
        segmentsToCreate.push(...fitted.segments);
        splinesToCreate.push(...fitted.splines);
      } else {
        this._collectContourSegments(worldPoints, minSegmentLength, segmentsToCreate);
      }
    }
    const entityCount = segmentsToCreate.length + splinesToCreate.length;
    if (entityCount === 0) {
      this._finish('Trace Image: Contours were detected, but they simplified away before segment creation.');
      return;
    }

    takeSnapshot();
    for (const segment of segmentsToCreate) {
      state.scene.addSegment(segment.start.x, segment.start.y, segment.end.x, segment.end.y, {
        merge: true,
        layer,
        construction: false,
      });
    }
    for (const spline of splinesToCreate) {
      state.scene.addSpline(spline, {
        merge: true,
        layer,
        construction: false,
      });
    }

    state.scene.solve();
    state.emit('change');
    this.app._scheduleRender?.();
    const entityLabel = traceSettings.curveMode === 'spline'
      ? 'spline'
      : (traceSettings.curveMode === 'hybrid' || traceSettings.curveMode === 'fitting' ? 'entity' : 'segment');
    this._finish(`Trace Image: Created ${entityCount} ${entityLabel}${entityCount === 1 ? '' : 's'} from ${contours.length} contour${contours.length === 1 ? '' : 's'}.`);
  }

  _getSelectedImage() {
    if (!Array.isArray(state.selectedEntities)) return null;
    const selectedImages = state.selectedEntities.filter((entity) => entity?.type === 'image');
    return selectedImages.length === 1 && state.selectedEntities.length === 1
      ? selectedImages[0]
      : null;
  }

  _mapContourPoint(point, raster, image) {
    const localX = raster.localRect.x + (point.x / Math.max(1, raster.canvas.width)) * raster.localRect.width;
    const localY = raster.localRect.y + (1 - (point.y / Math.max(1, raster.canvas.height))) * raster.localRect.height;
    return typeof image.mapLocalPoint === 'function'
      ? image.mapLocalPoint(localX, localY)
      : { x: image.x + localX, y: image.y + localY };
  }

  _collectContourSegments(points, minSegmentLength, segments) {
    if (!Array.isArray(points) || points.length < 3) {
      return;
    }
    const cleaned = [];
    for (const point of points) {
      const previous = cleaned[cleaned.length - 1];
      if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) <= minSegmentLength * 0.25) {
        continue;
      }
      cleaned.push(point);
    }
    if (cleaned.length < 3) {
      return;
    }

    for (let index = 0; index < cleaned.length; index++) {
      const start = cleaned[index];
      const end = cleaned[(index + 1) % cleaned.length];
      if (Math.hypot(end.x - start.x, end.y - start.y) <= minSegmentLength) {
        continue;
      }
      segments.push({
        start,
        end,
      });
    }
  }

  _collectContourSpline(points, minSegmentLength, splines) {
    if (!Array.isArray(points) || points.length < 3) return;
    const cleaned = [];
    for (const point of points) {
      const previous = cleaned[cleaned.length - 1];
      if (previous && Math.hypot(point.x - previous.x, point.y - previous.y) <= minSegmentLength) {
        continue;
      }
      cleaned.push(point);
    }
    if (cleaned.length < 3) return;
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) > minSegmentLength) {
      cleaned.push({ ...first });
    }
    if (cleaned.length >= 4) splines.push(cleaned);
  }

  _finish(message) {
    if (this.app.activeTool === this) {
      this.app.setActiveTool('select');
    }
    this.setStatus(message);
  }
}

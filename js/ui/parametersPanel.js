// ui/parametersPanel.js - Feature parameters editing panel
import { getFeatureIconSVG } from './featureIcons.js';
import { globalTessConfig } from '../cad/TessellationConfig.js';

/**
 * ParametersPanel - Displays and edits feature parameters
 */
export class ParametersPanel {
  constructor(container, partManager) {
    this.container = container;
    this.partManager = partManager;
    this.currentFeature = null;
    this.onParameterChange = null; // callback(featureId, paramName, value)

    this.init();
  }

  init() {
    this.container.innerHTML = `
      <div class="parameters-panel-header">
        <h3>Parameters</h3>
      </div>
      <div class="parameters-content" id="parameters-content">
        <p class="hint">Select a feature to edit parameters</p>
      </div>
    `;

    this.contentElement = this.container.querySelector('#parameters-content');
  }

  /**
   * Set callback for parameter changes (for recording)
   * @param {Function} callback - (featureId, paramName, value) => void
   */
  setOnParameterChange(callback) {
    this.onParameterChange = callback;
  }

  /**
   * Show parameters for a feature
   * @param {Feature} feature - The feature to display
   */
  showFeature(feature) {
    this.currentFeature = feature;
    const headerEl = this.container.querySelector('.parameters-panel-header');

    if (!feature) {
      if (headerEl) headerEl.innerHTML = '<h3>Parameters</h3>';
      this.contentElement.innerHTML = '<p class="hint">Select a feature to edit parameters</p>';
      return;
    }

    // Update header with feature icon and name
    if (headerEl) {
      headerEl.innerHTML = `<h3><span class="parameters-header-icon">${getFeatureIconSVG(feature.type)}</span>Parameters</h3>`;
    }

    this.contentElement.innerHTML = '';

    // Feature name
    const nameDiv = this.createParameter('Name', 'text', feature.name, (value) => {
      feature.name = value;
      this.partManager.notifyListeners();
    });
    this.contentElement.appendChild(nameDiv);

    // Type-specific parameters
    if (feature.type === 'extrude' || feature.type === 'extrude-cut') {
      this.showExtrudeParameters(feature);
    } else if (feature.type === 'revolve') {
      this.showRevolveParameters(feature);
    } else if (feature.type === 'sketch') {
      this.showSketchParameters(feature);
    }
  }

  /**
   * Show extrude feature parameters
   * @param {ExtrudeFeature} feature - The extrude feature
   */
  showExtrudeParameters(feature) {
    // Distance
    const distanceDiv = this.createParameter('Distance', 'number', feature.distance, (value) => {
      const parsed = parseFloat(value);
      this.partManager.modifyFeature(feature.id, (f) => {
        f.setDistance(parsed);
      });
      if (this.onParameterChange) this.onParameterChange(feature.id, 'distance', parsed);
    });
    this.contentElement.appendChild(distanceDiv);

    // Direction
    const directionDiv = this.createParameter('Direction', 'select', feature.direction, (value) => {
      const dir = parseInt(value, 10);
      this.partManager.modifyFeature(feature.id, (f) => {
        f.direction = dir;
      });
      if (this.onParameterChange) this.onParameterChange(feature.id, 'direction', dir);
    }, [
      { value: '1', label: 'Normal' },
      { value: '-1', label: 'Reverse' },
    ]);
    this.contentElement.appendChild(directionDiv);

    // Operation
    const operationDiv = this.createParameter('Operation', 'select', feature.operation, (value) => {
      this.partManager.modifyFeature(feature.id, (f) => {
        f.operation = value;
      });
      if (this.onParameterChange) this.onParameterChange(feature.id, 'operation', value);
    }, [
      { value: 'new', label: 'New Body' },
      { value: 'add', label: 'Add (Union)' },
      { value: 'subtract', label: 'Subtract (Cut)' },
      { value: 'intersect', label: 'Intersect' },
    ]);
    this.contentElement.appendChild(operationDiv);

    // Symmetric option
    const symmetricDiv = this.createParameter('Symmetric', 'checkbox', feature.symmetric, (value) => {
      this.partManager.modifyFeature(feature.id, (f) => {
        f.symmetric = value;
      });
      if (this.onParameterChange) this.onParameterChange(feature.id, 'symmetric', value);
    });
    this.contentElement.appendChild(symmetricDiv);
  }

  /**
   * Show revolve feature parameters
   * @param {RevolveFeature} feature - The revolve feature
   */
  showRevolveParameters(feature) {
    // Angle (in degrees for UI)
    const angleDegrees = (feature.angle * 180 / Math.PI).toFixed(1);
    const angleDiv = this.createParameter('Angle (°)', 'number', angleDegrees, (value) => {
      const radians = parseFloat(value) * Math.PI / 180;
      this.partManager.modifyFeature(feature.id, (f) => {
        f.setAngle(radians);
        if (Object.prototype.hasOwnProperty.call(f, 'segments')) {
          f.segments = globalTessConfig.curveSegments;
        }
      });
      if (this.onParameterChange) this.onParameterChange(feature.id, 'angle', radians);
    });
    this.contentElement.appendChild(angleDiv);

    const sketches = this.partManager.getFeatures().filter((candidate) => candidate.type === 'sketch');
    const sketchOptions = sketches.map((sketch) => ({ value: sketch.id, label: sketch.name }));
    if (sketchOptions.length === 0) {
      sketchOptions.push({ value: '', label: '(no sketches)' });
    }

    const sketchDiv = this.createParameter('Sketch', 'select', feature.sketchFeatureId || '', (value) => {
      const nextSketch = sketches.find((candidate) => candidate.id === value) || null;
      const nextAxisSegmentId = getPreferredRevolveAxisSegmentId(nextSketch, feature.axisSegmentId);
      this.partManager.modifyFeature(feature.id, (f) => {
        if (typeof f.setSketchFeature === 'function') {
          f.setSketchFeature(value || null);
        } else {
          f.sketchFeatureId = value || null;
        }
        if (typeof f.setAxisSegmentId === 'function') {
          f.setAxisSegmentId(nextAxisSegmentId);
        } else {
          f.axisSegmentId = nextAxisSegmentId;
        }
        if (Object.prototype.hasOwnProperty.call(f, 'segments')) {
          f.segments = globalTessConfig.curveSegments;
        }
      });
      if (this.onParameterChange) this.onParameterChange(feature.id, 'sketchFeatureId', value || null);
      this.showFeature(feature);
    }, sketchOptions);
    this.contentElement.appendChild(sketchDiv);

    if (feature.axisSource === 'manual') {
      const axisInfo = document.createElement('div');
      axisInfo.className = 'parameter-info';
      axisInfo.innerHTML = `<p><strong>Axis:</strong> ${describeRevolveAxis(feature)}</p>`;
      this.contentElement.appendChild(axisInfo);
    } else {
      const sketchFeature = sketches.find((candidate) => candidate.id === feature.sketchFeatureId) || null;
      const axisOptions = getRevolveAxisOptions(sketchFeature, feature.axisSegmentId);
      const axisDiv = this.createParameter(
        'Axis',
        'select',
        feature.axisSegmentId != null ? String(feature.axisSegmentId) : axisOptions[0].value,
        (value) => {
          const parsed = value === '' ? null : Number(value);
          const nextAxisSegmentId = Number.isNaN(parsed) ? null : parsed;
          this.partManager.modifyFeature(feature.id, (f) => {
            if (typeof f.setAxisSegmentId === 'function') {
              f.setAxisSegmentId(nextAxisSegmentId);
            } else {
              f.axisSegmentId = nextAxisSegmentId;
            }
            if (Object.prototype.hasOwnProperty.call(f, 'segments')) {
              f.segments = globalTessConfig.curveSegments;
            }
          });
          if (this.onParameterChange) this.onParameterChange(feature.id, 'axisSegmentId', nextAxisSegmentId);
          this.showFeature(feature);
        },
        axisOptions
      );
      this.contentElement.appendChild(axisDiv);
    }
  }

  /**
   * Show sketch feature parameters
   * @param {SketchFeature} feature - The sketch feature
   */
  showSketchParameters(feature) {
    const info = document.createElement('div');
    info.className = 'parameter-info';
    info.innerHTML = `
      <p><strong>Type:</strong> 2D Sketch</p>
      <p><strong>Segments:</strong> ${feature.sketch.segments.length}</p>
      <p><strong>Points:</strong> ${feature.sketch.points.length}</p>
    `;
    this.contentElement.appendChild(info);
  }

  /**
   * Create a parameter input element
   * @param {string} label - Parameter label
   * @param {string} type - Input type (text, number, checkbox, select)
   * @param {*} value - Current value
   * @param {Function} onChange - Change callback
   * @param {Array} [options] - Options for select type [{value, label}]
   */
  createParameter(label, type, value, onChange, options) {
    const div = document.createElement('div');
    div.className = 'parameter-row';

    const labelElement = document.createElement('label');
    labelElement.className = 'parameter-label';
    labelElement.textContent = label;

    let inputElement;

    if (type === 'checkbox') {
      inputElement = document.createElement('input');
      inputElement.type = 'checkbox';
      inputElement.checked = value;
      inputElement.addEventListener('change', (e) => {
        onChange(e.target.checked);
      });
    } else if (type === 'select') {
      inputElement = document.createElement('select');
      inputElement.className = 'parameter-input';
      for (const opt of options) {
        const optEl = document.createElement('option');
        optEl.value = opt.value;
        optEl.textContent = opt.label;
        if (String(opt.value) === String(value)) optEl.selected = true;
        inputElement.appendChild(optEl);
      }
      inputElement.addEventListener('change', (e) => {
        onChange(e.target.value);
      });
    } else {
      inputElement = document.createElement('input');
      inputElement.type = type;
      inputElement.value = value;
      inputElement.className = 'parameter-input';

      if (type === 'number') {
        inputElement.step = 'any';
      }

      inputElement.addEventListener('change', (e) => {
        onChange(e.target.value);
      });

      inputElement.addEventListener('input', (e) => {
        if (type === 'number') {
          // Live update for numbers
          onChange(e.target.value);
        }
      });
    }

    div.appendChild(labelElement);
    div.appendChild(inputElement);

    return div;
  }

  /**
   * Clear the panel
   */
  clear() {
    this.showFeature(null);
  }
}

function describeRevolveAxis(feature) {
  if (feature.axisSource === 'construction' && feature.axisSegmentId != null) {
    return `Construction line #${feature.axisSegmentId}`;
  }
  if (feature.axisSource === 'manual') {
    return 'Manual axis';
  }
  return 'Default axis';
}

function getPreferredRevolveAxisSegmentId(sketchFeature, currentAxisSegmentId = null) {
  if (!sketchFeature || typeof sketchFeature.getRevolveAxisCandidates !== 'function') {
    return null;
  }

  const candidates = sketchFeature.getRevolveAxisCandidates();
  if (candidates.length === 0) {
    return null;
  }

  const preserved = currentAxisSegmentId != null
    ? candidates.find((candidate) => candidate.segmentId === currentAxisSegmentId)
    : null;
  return preserved ? preserved.segmentId : candidates[0].segmentId;
}

function getRevolveAxisOptions(sketchFeature, currentAxisSegmentId = null) {
  if (!sketchFeature || typeof sketchFeature.getRevolveAxisCandidates !== 'function') {
    return [{ value: '', label: 'Default axis' }];
  }

  const candidates = sketchFeature.getRevolveAxisCandidates();
  if (candidates.length === 0) {
    return [{ value: '', label: 'Default axis' }];
  }

  const options = candidates.map((candidate) => ({
    value: String(candidate.segmentId),
    label: `Construction line #${candidate.segmentId}`,
  }));

  if (currentAxisSegmentId != null && !options.some((option) => option.value === String(currentAxisSegmentId))) {
    options.unshift({
      value: String(currentAxisSegmentId),
      label: `Construction line #${currentAxisSegmentId} (missing)`,
    });
  }

  return options;
}

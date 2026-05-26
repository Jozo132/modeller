// ui/parametersPanel.js - Feature parameters editing panel
import { getFeatureIconSVG } from './featureIcons.js';
import { globalTessConfig } from '../cad/TessellationConfig.js';
import { appendChamferBlendControls, appendFilletBlendControls } from './occtBlendSpecControls.js';

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
    } else if (feature.type === 'sweep') {
      this.showSweepParameters(feature);
    } else if (feature.type === 'loft') {
      this.showLoftParameters(feature);
    } else if (feature.type === 'chamfer') {
      this.showChamferParameters(feature);
    } else if (feature.type === 'fillet') {
      this.showFilletParameters(feature);
    } else if (feature.type === 'sketch') {
      this.showSketchParameters(feature);
    }
  }

  /**
   * Show extrude feature parameters
   * @param {ExtrudeFeature} feature - The extrude feature
   */
  showExtrudeParameters(feature) {
    const extentDiv = this.createParameter('Type', 'select', feature.extrudeType || 'distance', (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.extrudeType = value; });
      if (this.onParameterChange) this.onParameterChange(feature.id, 'extrudeType', value);
      this.showFeature(feature);
    }, [
      { value: 'distance', label: 'Distance' },
      { value: 'throughAll', label: 'Through All' },
      { value: 'upToNext', label: 'Up to Next' },
      { value: 'upToFace', label: 'Up to Face' },
      { value: 'offsetFromSurface', label: 'Offset from Surface' },
    ]);
    this.contentElement.appendChild(extentDiv);

    const distanceDiv = this.createParameter('Distance', 'number', feature.distance, (value) => {
      const parsed = parseFloat(value);
      this.partManager.modifyFeature(feature.id, (f) => {
        f.setDistance(parsed);
      });
      if (this.onParameterChange) this.onParameterChange(feature.id, 'distance', parsed);
    });
    this.contentElement.appendChild(distanceDiv);

    if ((feature.extrudeType || 'distance') === 'offsetFromSurface') {
      const offsetDiv = this.createParameter('Offset', 'number', feature.surfaceOffset || 0, (value) => {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) return;
        this.partManager.modifyFeature(feature.id, (f) => { f.surfaceOffset = parsed; });
        if (this.onParameterChange) this.onParameterChange(feature.id, 'surfaceOffset', parsed);
      });
      this.contentElement.appendChild(offsetDiv);
    }

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

    const symmetricDiv = this.createParameter('Symmetric', 'checkbox', feature.symmetric, (value) => {
      this.partManager.modifyFeature(feature.id, (f) => {
        f.symmetric = value;
      });
      if (this.onParameterChange) this.onParameterChange(feature.id, 'symmetric', value);
    });
    this.contentElement.appendChild(symmetricDiv);

    const taperDiv = this.createParameter('Taper', 'checkbox', !!feature.taper, (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.taper = value; });
      if (this.onParameterChange) this.onParameterChange(feature.id, 'taper', value);
      this.showFeature(feature);
    });
    this.contentElement.appendChild(taperDiv);

    if (feature.taper) {
      const taperAngleDiv = this.createParameter('Taper Angle (°)', 'number', feature.taperAngle || 0, (value) => {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) return;
        this.partManager.modifyFeature(feature.id, (f) => { f.taperAngle = parsed; });
        if (this.onParameterChange) this.onParameterChange(feature.id, 'taperAngle', parsed);
      });
      this.contentElement.appendChild(taperAngleDiv);
    }
  }

  /**
   * Show revolve feature parameters
   * @param {RevolveFeature} feature - The revolve feature
   */
  showRevolveParameters(feature) {
    const extentDiv = this.createParameter('Extent', 'select', feature.extentType || 'angle', (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.extentType = value; });
      if (this.onParameterChange) this.onParameterChange(feature.id, 'extentType', value);
      this.showFeature(feature);
    }, [
      { value: 'angle', label: 'Angle' },
      { value: 'throughAll', label: 'Through All' },
      { value: 'upToFace', label: 'Up to Face' },
      { value: 'offsetFromSurface', label: 'Offset from Surface' },
      { value: 'fromFaceToFace', label: 'From Face to Face' },
    ]);
    this.contentElement.appendChild(extentDiv);

    // Angle (in degrees for UI)
    if ((feature.extentType || 'angle') === 'angle') {
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
    }

    if ((feature.extentType || 'angle') === 'offsetFromSurface') {
      const offsetDiv = this.createParameter('Offset', 'number', feature.surfaceOffset || 0, (value) => {
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) return;
        this.partManager.modifyFeature(feature.id, (f) => { f.surfaceOffset = parsed; });
        if (this.onParameterChange) this.onParameterChange(feature.id, 'surfaceOffset', parsed);
      });
      this.contentElement.appendChild(offsetDiv);
    }

    const operationDiv = this.createParameter('Operation', 'select', feature.operation || 'new', (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.operation = value; });
      if (this.onParameterChange) this.onParameterChange(feature.id, 'operation', value);
    }, [
      { value: 'new', label: 'New Body' },
      { value: 'add', label: 'Add (Union)' },
      { value: 'subtract', label: 'Subtract (Cut)' },
      { value: 'intersect', label: 'Intersect' },
    ]);
    this.contentElement.appendChild(operationDiv);

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

  showSweepParameters(feature) {
    const sketches = this.partManager.getFeatures().filter((candidate) => candidate.type === 'sketch');
    const sketchOptions = sketches.map((sketch) => ({ value: sketch.id, label: sketch.name }));
    if (sketchOptions.length === 0) sketchOptions.push({ value: '', label: '(no sketches)' });

    this.contentElement.appendChild(this.createParameter('Profile', 'select', feature.profileSketchFeatureId || '', (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.setProfileSketchFeature(value || null); });
      this.showFeature(feature);
    }, sketchOptions));

    this.contentElement.appendChild(this.createParameter('Path', 'select', feature.pathSketchFeatureId || '', (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.setPathSketchFeature(value || null); });
      this.showFeature(feature);
    }, sketchOptions));

    this.contentElement.appendChild(this.createParameter('Operation', 'select', feature.operation || 'new', (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.operation = value; });
    }, [
      { value: 'new', label: 'New Body' },
      { value: 'add', label: 'Add (Union)' },
      { value: 'subtract', label: 'Subtract (Cut)' },
      { value: 'intersect', label: 'Intersect' },
    ]));

    this.contentElement.appendChild(this.createParameter('Solid', 'checkbox', !!feature.makeSolid, (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.makeSolid = value; });
    }));

    this.contentElement.appendChild(this.createParameter('Mode', 'select', feature.mode || 'frenet', (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.mode = value; });
    }, [
      { value: 'frenet', label: 'Frenet' },
      { value: 'fixed', label: 'Fixed' },
    ]));
  }

  showLoftParameters(feature) {
    const sketches = this.partManager.getFeatures().filter((candidate) => candidate.type === 'sketch');
    const sketchOptions = sketches.map((sketch) => ({ value: sketch.id, label: sketch.name }));
    if (sketchOptions.length === 0) sketchOptions.push({ value: '', label: '(no sketches)' });
    const sections = Array.isArray(feature.sectionSketchFeatureIds) ? feature.sectionSketchFeatureIds : [];

    this.contentElement.appendChild(this.createParameter('Section 1', 'select', sections[0] || '', (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.setSectionSketchFeature(0, value || null); });
      this.showFeature(feature);
    }, sketchOptions));

    this.contentElement.appendChild(this.createParameter('Section 2', 'select', sections[1] || '', (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.setSectionSketchFeature(1, value || null); });
      this.showFeature(feature);
    }, sketchOptions));

    this.contentElement.appendChild(this.createParameter('Operation', 'select', feature.operation || 'new', (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.operation = value; });
    }, [
      { value: 'new', label: 'New Body' },
      { value: 'add', label: 'Add (Union)' },
      { value: 'subtract', label: 'Subtract (Cut)' },
      { value: 'intersect', label: 'Intersect' },
    ]));

    this.contentElement.appendChild(this.createParameter('Solid', 'checkbox', !!feature.makeSolid, (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.makeSolid = value; });
    }));

    this.contentElement.appendChild(this.createParameter('Ruled', 'checkbox', !!feature.ruled, (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.ruled = value; });
    }));

    this.contentElement.appendChild(this.createParameter('Continuity', 'select', feature.continuity || 'C2', (value) => {
      this.partManager.modifyFeature(feature.id, (f) => { f.continuity = value; });
    }, [
      { value: 'C0', label: 'C0' },
      { value: 'C1', label: 'C1' },
      { value: 'C2', label: 'C2' },
    ]));
  }

  showChamferParameters(feature) {
    this.contentElement.appendChild(this.createParameter('Distance', 'number', feature.distance, (value) => {
      const parsed = parseFloat(value);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      this.partManager.modifyFeature(feature.id, (f) => {
        if (typeof f.setDistance === 'function') f.setDistance(parsed);
        else f.distance = parsed;
      });
    }));

    this.contentElement.appendChild(this.createInfoBlock(
      'OCCT Spec',
      'Optional JSON merged with the selected edges and default distance. Pass through any library-supported chamfer fields such as mode, contourMode, referenceFace, and per-edge distance1/distance2/angleDegrees.'
    ));

    this.contentElement.appendChild(this.createParameter(
      'OCCT Spec (JSON)',
      'textarea',
      this.formatOcctSpec(feature.occtSpec),
      (value) => {
        const parsed = this.parseOcctSpec(value, 'chamfer');
        if (!parsed.ok) return;
        this.partManager.modifyFeature(feature.id, (f) => {
          if (typeof f.setOcctSpec === 'function') f.setOcctSpec(parsed.spec);
          else f.occtSpec = parsed.spec;
        });
        this.showFeature(feature);
      },
      { rows: 10 }
    ));
  }

  showFilletParameters(feature) {
    this.contentElement.appendChild(this.createParameter('Radius', 'number', feature.radius, (value) => {
      const parsed = parseFloat(value);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      this.partManager.modifyFeature(feature.id, (f) => {
        if (typeof f.setRadius === 'function') f.setRadius(parsed);
        else f.radius = parsed;
      });
    }));

    this.contentElement.appendChild(this.createInfoBlock(
      'OCCT Spec',
      'Optional JSON merged with the selected edges and default radius. Pass through any library-supported fillet fields such as continuity, blendShape, overflowMode, and per-edge radius laws or station lists.'
    ));

    this.contentElement.appendChild(this.createParameter(
      'OCCT Spec (JSON)',
      'textarea',
      this.formatOcctSpec(feature.occtSpec),
      (value) => {
        const parsed = this.parseOcctSpec(value, 'fillet');
        if (!parsed.ok) return;
        this.partManager.modifyFeature(feature.id, (f) => {
          if (typeof f.setOcctSpec === 'function') f.setOcctSpec(parsed.spec);
          else f.occtSpec = parsed.spec;
        });
        this.showFeature(feature);
      },
      { rows: 10 }
    ));
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

  createInfoBlock(title, text) {
    const info = document.createElement('div');
    info.className = 'parameter-info';
    info.innerHTML = `<p><strong>${title}:</strong> ${text}</p>`;
    return info;
  }

  formatOcctSpec(spec) {
    return spec && typeof spec === 'object' ? JSON.stringify(spec, null, 2) : '';
  }

  parseOcctSpec(value, label) {
    const trimmed = String(value || '').trim();
    if (!trimmed) return { ok: true, spec: null };
    try {
      const parsed = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Expected a JSON object');
      }
      return { ok: true, spec: parsed };
    } catch (error) {
      console.warn(`Invalid OCCT ${label} spec JSON`, error);
      return { ok: false, spec: null };
    }
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
    } else if (type === 'textarea') {
      inputElement = document.createElement('textarea');
      inputElement.className = 'parameter-input';
      inputElement.value = value || '';
      inputElement.rows = Number(options?.rows) || 8;
      inputElement.spellcheck = false;
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

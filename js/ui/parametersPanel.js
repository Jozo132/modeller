// ui/parametersPanel.js - Feature parameters editing panel

/**
 * ParametersPanel - Displays and edits feature parameters
 */
export class ParametersPanel {
  constructor(container, partManager) {
    this.container = container;
    this.partManager = partManager;
    this.currentFeature = null;

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
   * Show parameters for a feature
   * @param {Feature} feature - The feature to display
   */
  showFeature(feature) {
    this.currentFeature = feature;

    if (!feature) {
      this.contentElement.innerHTML = '<p class="hint">Select a feature to edit parameters</p>';
      return;
    }

    this.contentElement.innerHTML = '';

    // Feature name
    const nameDiv = this.createParameter('Name', 'text', feature.name, (value) => {
      feature.name = value;
      this.partManager.notifyListeners();
    });
    this.contentElement.appendChild(nameDiv);

    // Type-specific parameters
    if (feature.type === 'extrude') {
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
      this.partManager.modifyFeature(feature.id, (f) => {
        f.setDistance(parseFloat(value));
      });
    });
    this.contentElement.appendChild(distanceDiv);

    // Symmetric option
    const symmetricDiv = this.createParameter('Symmetric', 'checkbox', feature.symmetric, (value) => {
      this.partManager.modifyFeature(feature.id, (f) => {
        f.symmetric = value;
      });
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
      });
    });
    this.contentElement.appendChild(angleDiv);

    // Segments
    const segmentsDiv = this.createParameter('Segments', 'number', feature.segments, (value) => {
      this.partManager.modifyFeature(feature.id, (f) => {
        f.segments = parseInt(value);
      });
    });
    this.contentElement.appendChild(segmentsDiv);
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
   * @param {string} type - Input type (text, number, checkbox)
   * @param {*} value - Current value
   * @param {Function} onChange - Change callback
   */
  createParameter(label, type, value, onChange) {
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

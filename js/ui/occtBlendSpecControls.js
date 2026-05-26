const FILLET_RADIUS_MODE_OPTIONS = [
  { value: 'constant', label: 'Constant Radius' },
  { value: 'startEnd', label: 'Start / End Radius' },
  { value: 'variable', label: 'Station Radii' },
  { value: 'law', label: 'Radius Law' },
];

const CHAMFER_MODE_OPTIONS = [
  { value: 'symmetric', label: 'Symmetric' },
  { value: 'twoDistance', label: 'Two Distance' },
  { value: 'distanceAngle', label: 'Distance + Angle' },
];

const BOOLEAN_MODE_OPTIONS = [
  { value: '', label: 'Kernel Default' },
  { value: 'true', label: 'Enabled' },
  { value: 'false', label: 'Disabled' },
];

const FILLET_BLEND_SHAPE_OPTIONS = [
  { value: '', label: 'Kernel Default' },
  { value: 'rational', label: 'Rational' },
  { value: 'quasiAngular', label: 'Quasi Angular' },
  { value: 'polynomial', label: 'Polynomial' },
];

const FILLET_CONTINUITY_OPTIONS = [
  { value: '', label: 'Kernel Default' },
  { value: 'C0', label: 'C0' },
  { value: 'C1', label: 'C1' },
  { value: 'C2', label: 'C2' },
  { value: 'G0', label: 'G0' },
  { value: 'G1', label: 'G1' },
  { value: 'G2', label: 'G2' },
];

const CORNER_MODE_OPTIONS = [
  { value: '', label: 'Kernel Default' },
  { value: 'rollingBall', label: 'Rolling Ball' },
  { value: 'setback', label: 'Setback' },
];

const OVERFLOW_MODE_OPTIONS = [
  { value: '', label: 'Kernel Default' },
  { value: 'fail', label: 'Fail' },
  { value: 'clamp', label: 'Clamp' },
  { value: 'heal', label: 'Heal' },
];

const ANGLE_UNIT_OPTIONS = [
  { value: 'radians', label: 'Radians' },
  { value: 'degrees', label: 'Degrees' },
];

const LAW_TYPE_OPTIONS = [
  { value: 'constant', label: 'Constant' },
  { value: 'linear', label: 'Linear' },
];

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneJsonLike(value) {
  if (Array.isArray(value)) return value.map((entry) => cloneJsonLike(entry));
  if (!isPlainObject(value)) return value;
  const cloned = {};
  for (const [key, entry] of Object.entries(value)) {
    cloned[key] = cloneJsonLike(entry);
  }
  return cloned;
}

function toFiniteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanupReferenceFace(face) {
  if (!isPlainObject(face)) return null;
  const cleaned = {};
  if (typeof face.stableHash === 'string' && face.stableHash.trim()) {
    cleaned.stableHash = face.stableHash.trim();
  }
  const topoId = toFiniteNumber(face.topoId);
  if (topoId != null) cleaned.topoId = Math.trunc(topoId);
  return Object.keys(cleaned).length > 0 ? cleaned : null;
}

function cleanupStations(stations) {
  if (!Array.isArray(stations)) return [];
  return stations
    .map((station) => {
      if (!isPlainObject(station)) return null;
      const t = toFiniteNumber(station.t);
      const radius = toFiniteNumber(station.radius);
      if (t == null || radius == null) return null;
      return { t, radius };
    })
    .filter(Boolean);
}

function cleanupLaw(law) {
  if (!isPlainObject(law)) return null;
  const type = law.type === 'linear' ? 'linear' : 'constant';
  if (type === 'linear') {
    const startRadius = toFiniteNumber(law.startRadius);
    const endRadius = toFiniteNumber(law.endRadius);
    if (startRadius == null || endRadius == null) return null;
    return { type, startRadius, endRadius };
  }
  const radius = toFiniteNumber(law.radius);
  return radius == null ? null : { type, radius };
}

function cleanupLimits(limits) {
  if (!isPlainObject(limits)) return null;
  const start = toFiniteNumber(limits.start);
  const end = toFiniteNumber(limits.end);
  if (start == null || end == null) return null;
  return {
    start,
    end,
    normalized: limits.normalized !== false,
  };
}

function cleanupJsonObject(value) {
  return isPlainObject(value) && Object.keys(value).length > 0 ? cloneJsonLike(value) : null;
}

function cleanupAngleFields(target) {
  if (!isPlainObject(target)) return;
  const angleDegrees = toFiniteNumber(target.angleDegrees);
  const angleRadians = toFiniteNumber(target.angleRadians);
  if (angleDegrees != null) {
    target.angleDegrees = angleDegrees;
    delete target.angleRadians;
    return;
  }
  if (angleRadians != null) {
    target.angleRadians = angleRadians;
    delete target.angleDegrees;
    return;
  }
  delete target.angleDegrees;
  delete target.angleRadians;
}

function finalizeUnit(spec) {
  if (!isPlainObject(spec.unit)) {
    delete spec.unit;
    return;
  }
  if (spec.unit.angle === 'degrees') {
    spec.unit = { angle: 'degrees' };
    return;
  }
  delete spec.unit;
}

function deleteEmptyTopLevelKeys(spec, keepKeys = []) {
  for (const [key, value] of Object.entries(spec)) {
    if (keepKeys.includes(key)) continue;
    if (value == null || value === '') {
      delete spec[key];
      continue;
    }
    if (isPlainObject(value) && Object.keys(value).length === 0) {
      delete spec[key];
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      delete spec[key];
    }
  }
}

function finalizeFilletSpec(spec) {
  const next = isPlainObject(spec) ? cloneJsonLike(spec) : {};
  const mode = next.radiusMode || 'constant';
  if (mode === 'constant') {
    delete next.radiusMode;
  } else {
    next.radiusMode = mode;
  }

  delete next.schemaVersion;
  delete next.radius;

  if (mode !== 'startEnd') {
    delete next.startRadius;
    delete next.endRadius;
  } else {
    next.startRadius = toFiniteNumber(next.startRadius);
    next.endRadius = toFiniteNumber(next.endRadius);
    if (next.startRadius == null) delete next.startRadius;
    if (next.endRadius == null) delete next.endRadius;
  }

  if (mode !== 'variable') {
    delete next.stations;
  } else {
    next.stations = cleanupStations(next.stations);
    if (next.stations.length === 0) delete next.stations;
  }

  if (mode !== 'law') {
    delete next.law;
  } else {
    next.law = cleanupLaw(next.law);
    if (!next.law) delete next.law;
  }

  next.limits = cleanupLimits(next.limits);
  if (!next.limits) delete next.limits;

  if (typeof next.tangentPropagation !== 'boolean') delete next.tangentPropagation;
  if (next.allowUnknownFields !== true) delete next.allowUnknownFields;
  if (typeof next.blendShape !== 'string' || !next.blendShape) delete next.blendShape;
  if (typeof next.continuity !== 'string' || !next.continuity) delete next.continuity;
  if (typeof next.cornerMode !== 'string' || !next.cornerMode) delete next.cornerMode;
  if (typeof next.overflowMode !== 'string' || !next.overflowMode) delete next.overflowMode;
  next.angularTolerance = toFiniteNumber(next.angularTolerance);
  if (next.angularTolerance == null) delete next.angularTolerance;
  next.metadata = cleanupJsonObject(next.metadata);
  if (!next.metadata) delete next.metadata;
  if (!Array.isArray(next.edges) || next.edges.length === 0) delete next.edges;

  finalizeUnit(next);
  deleteEmptyTopLevelKeys(next, ['edges']);
  return Object.keys(next).length > 0 ? next : null;
}

function finalizeChamferSpec(spec) {
  const next = isPlainObject(spec) ? cloneJsonLike(spec) : {};
  const mode = next.mode || 'symmetric';
  if (mode === 'symmetric') {
    delete next.mode;
  } else {
    next.mode = mode;
  }

  delete next.schemaVersion;
  delete next.distance;

  if (mode !== 'twoDistance') {
    delete next.distance1;
    delete next.distance2;
  } else {
    next.distance1 = toFiniteNumber(next.distance1);
    next.distance2 = toFiniteNumber(next.distance2);
    if (next.distance1 == null) delete next.distance1;
    if (next.distance2 == null) delete next.distance2;
  }

  if (mode !== 'distanceAngle') {
    delete next.angleDegrees;
    delete next.angleRadians;
    delete next.referenceFace;
  } else {
    cleanupAngleFields(next);
    next.referenceFace = cleanupReferenceFace(next.referenceFace);
    if (!next.referenceFace) delete next.referenceFace;
  }

  next.limits = cleanupLimits(next.limits);
  if (!next.limits) delete next.limits;

  if (typeof next.tangentPropagation !== 'boolean') delete next.tangentPropagation;
  if (next.allowUnknownFields !== true) delete next.allowUnknownFields;
  if (typeof next.cornerMode !== 'string' || !next.cornerMode) delete next.cornerMode;
  if (typeof next.overflowMode !== 'string' || !next.overflowMode) delete next.overflowMode;
  next.metadata = cleanupJsonObject(next.metadata);
  if (!next.metadata) delete next.metadata;
  if (!Array.isArray(next.edges) || next.edges.length === 0) delete next.edges;

  finalizeUnit(next);
  deleteEmptyTopLevelKeys(next, ['edges']);
  return Object.keys(next).length > 0 ? next : null;
}

function getFilletMode(spec) {
  return spec?.radiusMode || 'constant';
}

function getChamferMode(spec) {
  return spec?.mode || 'symmetric';
}

function getAngleUnit(spec) {
  return spec?.unit?.angle === 'degrees' ? 'degrees' : 'radians';
}

function getBooleanMode(value) {
  return typeof value === 'boolean' ? String(value) : '';
}

function formatJson(value) {
  return value && typeof value === 'object' ? JSON.stringify(value, null, 2) : '';
}

function formatJsonArray(value) {
  return Array.isArray(value) && value.length > 0 ? JSON.stringify(value, null, 2) : '';
}

function parseJsonObject(text, label) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed);
  if (!isPlainObject(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

function parseJsonArray(text, label) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return parsed;
}

function createRow(doc, label, control) {
  const row = doc.createElement('div');
  row.className = 'parameter-row';
  const labelElement = doc.createElement('label');
  labelElement.className = 'parameter-label';
  labelElement.textContent = label;
  row.appendChild(labelElement);
  row.appendChild(control);
  return row;
}

function createInput(doc, type, value, onChange, options = {}) {
  const input = doc.createElement('input');
  input.type = type;
  input.className = 'parameter-input';
  if (type === 'checkbox') {
    input.checked = !!value;
    input.addEventListener('change', (event) => onChange(event.target.checked));
    return input;
  }
  input.value = value ?? '';
  if (type === 'number') input.step = 'any';
  if (options.placeholder) input.placeholder = options.placeholder;
  input.addEventListener('change', (event) => onChange(event.target.value));
  return input;
}

function createSelect(doc, value, optionList, onChange) {
  const select = doc.createElement('select');
  select.className = 'parameter-input';
  for (const option of optionList) {
    const optionElement = doc.createElement('option');
    optionElement.value = option.value;
    optionElement.textContent = option.label;
    if (String(option.value) === String(value)) optionElement.selected = true;
    select.appendChild(optionElement);
  }
  select.addEventListener('change', (event) => onChange(event.target.value));
  return select;
}

function createTextarea(doc, value, onChange, rows = 8) {
  const textarea = doc.createElement('textarea');
  textarea.className = 'parameter-input';
  textarea.value = value || '';
  textarea.rows = rows;
  textarea.spellcheck = false;
  textarea.addEventListener('change', (event) => onChange(event.target.value));
  return textarea;
}

function createButton(doc, label, onClick, className = '') {
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = `parameter-action-button ${className}`.trim();
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

function appendInfoBlock(container, text) {
  const doc = container.ownerDocument;
  const info = doc.createElement('div');
  info.className = 'parameter-info';
  info.innerHTML = `<p>${text}</p>`;
  container.appendChild(info);
}

function appendSectionTitle(container, title) {
  const doc = container.ownerDocument;
  const titleElement = doc.createElement('div');
  titleElement.className = 'parameter-subsection-title';
  titleElement.textContent = title;
  container.appendChild(titleElement);
}

function createAdvancedDetails(container, title, open) {
  const doc = container.ownerDocument;
  const details = doc.createElement('details');
  details.className = 'parameter-advanced-details';
  details.open = open;
  const summary = doc.createElement('summary');
  summary.textContent = title;
  details.appendChild(summary);
  const body = doc.createElement('div');
  body.className = 'parameter-advanced-body';
  details.appendChild(body);
  container.appendChild(details);
  return body;
}

function appendStationEditor(container, stations, onCommit) {
  const doc = container.ownerDocument;
  appendSectionTitle(container, 'Radius Stations');
  appendInfoBlock(container, 'Station positions use normalized edge parameters from 0 to 1.');
  const list = doc.createElement('div');
  list.className = 'parameter-array-list';
  const effectiveStations = stations.length > 0 ? stations : [{ t: 0, radius: null }];
  effectiveStations.forEach((station, index) => {
    const row = doc.createElement('div');
    row.className = 'parameter-array-row';

    const tInput = createInput(doc, 'number', station.t ?? '', (value) => {
      const nextStations = effectiveStations.map((entry) => ({ ...entry }));
      nextStations[index].t = value;
      onCommit(nextStations);
    });
    tInput.placeholder = 't';

    const radiusInput = createInput(doc, 'number', station.radius ?? '', (value) => {
      const nextStations = effectiveStations.map((entry) => ({ ...entry }));
      nextStations[index].radius = value;
      onCommit(nextStations);
    });
    radiusInput.placeholder = 'radius';

    row.appendChild(tInput);
    row.appendChild(radiusInput);
    row.appendChild(createButton(doc, 'Remove', () => {
      const nextStations = effectiveStations.filter((_, stationIndex) => stationIndex !== index);
      onCommit(nextStations);
    }, 'parameter-action-button-danger'));
    list.appendChild(row);
  });
  container.appendChild(list);
  container.appendChild(createButton(doc, 'Add Station', () => {
    onCommit([...effectiveStations, { t: '', radius: '' }]);
  }));
}

function hasFilletAdvancedContent(spec) {
  if (!isPlainObject(spec)) return false;
  return [
    'blendShape',
    'continuity',
    'angularTolerance',
    'cornerMode',
    'overflowMode',
    'limits',
    'allowUnknownFields',
    'metadata',
    'edges',
    'unit',
  ].some((key) => spec[key] != null);
}

function hasChamferAdvancedContent(spec) {
  if (!isPlainObject(spec)) return false;
  return [
    'cornerMode',
    'overflowMode',
    'limits',
    'allowUnknownFields',
    'metadata',
    'edges',
    'unit',
  ].some((key) => spec[key] != null);
}

function updateSpec(feature, finalize, applySpec, mutate, rerender = false) {
  const draft = feature?.occtSpec && typeof feature.occtSpec === 'object'
    ? cloneJsonLike(feature.occtSpec)
    : {};
  mutate(draft);
  applySpec(finalize(draft));
  if (rerender) rerender();
}

export function appendFilletBlendControls(options) {
  const {
    container,
    feature,
    baseRadius,
    setBaseRadius,
    applySpec,
    rerender,
    reportError,
  } = options;
  const doc = container.ownerDocument;
  const spec = feature?.occtSpec && typeof feature.occtSpec === 'object' ? feature.occtSpec : null;
  const radiusMode = getFilletMode(spec);
  const tangentMode = getBooleanMode(spec?.tangentPropagation);

  container.appendChild(createRow(doc, 'Radius Mode', createSelect(doc, radiusMode, FILLET_RADIUS_MODE_OPTIONS, (value) => {
    updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
      if (value === 'constant') delete draft.radiusMode;
      else draft.radiusMode = value;
    }, rerender);
  })));

  if (radiusMode === 'constant') {
    const visibleRadius = toFiniteNumber(spec?.radius) ?? baseRadius;
    container.appendChild(createRow(doc, 'Radius', createInput(doc, 'number', visibleRadius, (value) => {
      const parsed = toFiniteNumber(value);
      if (parsed == null || parsed <= 0) return;
      setBaseRadius(parsed);
      updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
        delete draft.radius;
      });
    })));
  } else if (radiusMode === 'startEnd') {
    container.appendChild(createRow(doc, 'Start Radius', createInput(doc, 'number', spec?.startRadius ?? '', (value) => {
      updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
        draft.startRadius = value;
      });
    })));
    container.appendChild(createRow(doc, 'End Radius', createInput(doc, 'number', spec?.endRadius ?? '', (value) => {
      updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
        draft.endRadius = value;
      });
    })));
  } else if (radiusMode === 'variable') {
    appendStationEditor(container, cleanupStations(spec?.stations), (stations) => {
      updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
        draft.stations = stations;
      }, rerender);
    });
  } else if (radiusMode === 'law') {
    const lawType = spec?.law?.type === 'linear' ? 'linear' : 'constant';
    container.appendChild(createRow(doc, 'Law Type', createSelect(doc, lawType, LAW_TYPE_OPTIONS, (value) => {
      updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
        draft.law = value === 'linear'
          ? { type: 'linear', startRadius: draft.law?.startRadius ?? '', endRadius: draft.law?.endRadius ?? '' }
          : { type: 'constant', radius: draft.law?.radius ?? (toFiniteNumber(baseRadius) ?? '') };
      }, rerender);
    })));
    if (lawType === 'linear') {
      container.appendChild(createRow(doc, 'Law Start Radius', createInput(doc, 'number', spec?.law?.startRadius ?? '', (value) => {
        updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
          draft.law = { ...(draft.law || {}), type: 'linear', startRadius: value };
        });
      })));
      container.appendChild(createRow(doc, 'Law End Radius', createInput(doc, 'number', spec?.law?.endRadius ?? '', (value) => {
        updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
          draft.law = { ...(draft.law || {}), type: 'linear', endRadius: value };
        });
      })));
    } else {
      container.appendChild(createRow(doc, 'Law Radius', createInput(doc, 'number', spec?.law?.radius ?? '', (value) => {
        updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
          draft.law = { ...(draft.law || {}), type: 'constant', radius: value };
        });
      })));
    }
  }

  container.appendChild(createRow(doc, 'Tangent Propagation', createSelect(doc, tangentMode, BOOLEAN_MODE_OPTIONS, (value) => {
    updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
      if (!value) delete draft.tangentPropagation;
      else draft.tangentPropagation = value === 'true';
    });
  })));

  const advanced = createAdvancedDetails(container, 'Advanced OCCT Options', hasFilletAdvancedContent(spec));
  advanced.appendChild(createRow(doc, 'Blend Shape', createSelect(doc, spec?.blendShape || '', FILLET_BLEND_SHAPE_OPTIONS, (value) => {
    updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
      if (!value) delete draft.blendShape;
      else draft.blendShape = value;
    });
  })));
  advanced.appendChild(createRow(doc, 'Continuity', createSelect(doc, spec?.continuity || '', FILLET_CONTINUITY_OPTIONS, (value) => {
    updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
      if (!value) delete draft.continuity;
      else draft.continuity = value;
    });
  })));
  advanced.appendChild(createRow(doc, 'Angular Tolerance', createInput(doc, 'number', spec?.angularTolerance ?? '', (value) => {
    updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
      draft.angularTolerance = value;
    });
  })));
  advanced.appendChild(createRow(doc, 'Corner Mode', createSelect(doc, spec?.cornerMode || '', CORNER_MODE_OPTIONS, (value) => {
    updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
      if (!value) delete draft.cornerMode;
      else draft.cornerMode = value;
    });
  })));
  advanced.appendChild(createRow(doc, 'Overflow Mode', createSelect(doc, spec?.overflowMode || '', OVERFLOW_MODE_OPTIONS, (value) => {
    updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
      if (!value) delete draft.overflowMode;
      else draft.overflowMode = value;
    });
  })));

  const limitsEnabled = !!cleanupLimits(spec?.limits);
  advanced.appendChild(createRow(doc, 'Partial Edge Limits', createInput(doc, 'checkbox', limitsEnabled, (checked) => {
    updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
      draft.limits = checked
        ? { start: draft.limits?.start ?? 0, end: draft.limits?.end ?? 1, normalized: draft.limits?.normalized !== false }
        : null;
    }, rerender);
  })));
  if (limitsEnabled) {
    advanced.appendChild(createRow(doc, 'Limit Start', createInput(doc, 'number', spec?.limits?.start ?? 0, (value) => {
      updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
        draft.limits = { ...(draft.limits || {}), start: value };
      });
    })));
    advanced.appendChild(createRow(doc, 'Limit End', createInput(doc, 'number', spec?.limits?.end ?? 1, (value) => {
      updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
        draft.limits = { ...(draft.limits || {}), end: value };
      });
    })));
    advanced.appendChild(createRow(doc, 'Normalized Limits', createInput(doc, 'checkbox', spec?.limits?.normalized !== false, (checked) => {
      updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
        draft.limits = { ...(draft.limits || {}), normalized: checked };
      });
    })));
  }

  advanced.appendChild(createRow(doc, 'Angle Unit', createSelect(doc, getAngleUnit(spec), ANGLE_UNIT_OPTIONS, (value) => {
    updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
      draft.unit = value === 'degrees' ? { angle: 'degrees' } : null;
    });
  })));
  advanced.appendChild(createRow(doc, 'Allow Unknown Fields', createInput(doc, 'checkbox', spec?.allowUnknownFields === true, (checked) => {
    updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
      draft.allowUnknownFields = checked;
    });
  })));

  appendInfoBlock(advanced, 'Metadata and per-edge overrides remain available for cases where different selected edges need different settings than the shared controls above.');
  advanced.appendChild(createRow(doc, 'Metadata (JSON)', createTextarea(doc, formatJson(spec?.metadata), (value) => {
    try {
      const parsed = parseJsonObject(value, 'Metadata');
      updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
        draft.metadata = parsed;
      });
    } catch (error) {
      reportError(error.message);
    }
  }, 6)));
  advanced.appendChild(createRow(doc, 'Per-edge Overrides (JSON)', createTextarea(doc, formatJsonArray(spec?.edges), (value) => {
    try {
      const parsed = parseJsonArray(value, 'Per-edge overrides');
      updateSpec(feature, finalizeFilletSpec, applySpec, (draft) => {
        draft.edges = parsed;
      });
    } catch (error) {
      reportError(error.message);
    }
  }, 8)));
}

export function appendChamferBlendControls(options) {
  const {
    container,
    feature,
    baseDistance,
    setBaseDistance,
    applySpec,
    rerender,
    reportError,
  } = options;
  const doc = container.ownerDocument;
  const spec = feature?.occtSpec && typeof feature.occtSpec === 'object' ? feature.occtSpec : null;
  const mode = getChamferMode(spec);
  const tangentMode = getBooleanMode(spec?.tangentPropagation);
  const angleUnit = getAngleUnit(spec);

  container.appendChild(createRow(doc, 'Chamfer Mode', createSelect(doc, mode, CHAMFER_MODE_OPTIONS, (value) => {
    updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
      if (value === 'symmetric') delete draft.mode;
      else draft.mode = value;
    }, rerender);
  })));

  if (mode === 'symmetric') {
    const visibleDistance = toFiniteNumber(spec?.distance) ?? baseDistance;
    container.appendChild(createRow(doc, 'Distance', createInput(doc, 'number', visibleDistance, (value) => {
      const parsed = toFiniteNumber(value);
      if (parsed == null || parsed <= 0) return;
      setBaseDistance(parsed);
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        delete draft.distance;
      });
    })));
  } else if (mode === 'twoDistance') {
    container.appendChild(createRow(doc, 'Distance 1', createInput(doc, 'number', spec?.distance1 ?? '', (value) => {
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        draft.distance1 = value;
      });
    })));
    container.appendChild(createRow(doc, 'Distance 2', createInput(doc, 'number', spec?.distance2 ?? '', (value) => {
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        draft.distance2 = value;
      });
    })));
  } else if (mode === 'distanceAngle') {
    const visibleDistance = toFiniteNumber(spec?.distance) ?? baseDistance;
    container.appendChild(createRow(doc, 'Distance', createInput(doc, 'number', visibleDistance, (value) => {
      const parsed = toFiniteNumber(value);
      if (parsed == null || parsed <= 0) return;
      setBaseDistance(parsed);
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        delete draft.distance;
      });
    })));
    container.appendChild(createRow(doc, 'Angle Unit', createSelect(doc, angleUnit, ANGLE_UNIT_OPTIONS, (value) => {
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        draft.unit = value === 'degrees' ? { angle: 'degrees' } : null;
      }, rerender);
    })));
    container.appendChild(createRow(doc, angleUnit === 'degrees' ? 'Angle (deg)' : 'Angle (rad)', createInput(doc, 'number', angleUnit === 'degrees' ? (spec?.angleDegrees ?? '') : (spec?.angleRadians ?? ''), (value) => {
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        if (getAngleUnit(draft) === 'degrees') draft.angleDegrees = value;
        else draft.angleRadians = value;
      });
    })));
    container.appendChild(createRow(doc, 'Reference Face Stable Hash', createInput(doc, 'text', spec?.referenceFace?.stableHash ?? '', (value) => {
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        draft.referenceFace = { ...(draft.referenceFace || {}), stableHash: value };
      });
    }, { placeholder: 'optional stable hash' })));
    container.appendChild(createRow(doc, 'Reference Face Topo ID', createInput(doc, 'number', spec?.referenceFace?.topoId ?? '', (value) => {
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        draft.referenceFace = { ...(draft.referenceFace || {}), topoId: value };
      });
    })));
  }

  container.appendChild(createRow(doc, 'Tangent Propagation', createSelect(doc, tangentMode, BOOLEAN_MODE_OPTIONS, (value) => {
    updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
      if (!value) delete draft.tangentPropagation;
      else draft.tangentPropagation = value === 'true';
    });
  })));

  const advanced = createAdvancedDetails(container, 'Advanced OCCT Options', hasChamferAdvancedContent(spec));
  advanced.appendChild(createRow(doc, 'Corner Mode', createSelect(doc, spec?.cornerMode || '', CORNER_MODE_OPTIONS, (value) => {
    updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
      if (!value) delete draft.cornerMode;
      else draft.cornerMode = value;
    });
  })));
  advanced.appendChild(createRow(doc, 'Overflow Mode', createSelect(doc, spec?.overflowMode || '', OVERFLOW_MODE_OPTIONS, (value) => {
    updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
      if (!value) delete draft.overflowMode;
      else draft.overflowMode = value;
    });
  })));

  const limitsEnabled = !!cleanupLimits(spec?.limits);
  advanced.appendChild(createRow(doc, 'Partial Edge Limits', createInput(doc, 'checkbox', limitsEnabled, (checked) => {
    updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
      draft.limits = checked
        ? { start: draft.limits?.start ?? 0, end: draft.limits?.end ?? 1, normalized: draft.limits?.normalized !== false }
        : null;
    }, rerender);
  })));
  if (limitsEnabled) {
    advanced.appendChild(createRow(doc, 'Limit Start', createInput(doc, 'number', spec?.limits?.start ?? 0, (value) => {
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        draft.limits = { ...(draft.limits || {}), start: value };
      });
    })));
    advanced.appendChild(createRow(doc, 'Limit End', createInput(doc, 'number', spec?.limits?.end ?? 1, (value) => {
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        draft.limits = { ...(draft.limits || {}), end: value };
      });
    })));
    advanced.appendChild(createRow(doc, 'Normalized Limits', createInput(doc, 'checkbox', spec?.limits?.normalized !== false, (checked) => {
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        draft.limits = { ...(draft.limits || {}), normalized: checked };
      });
    })));
  }

  advanced.appendChild(createRow(doc, 'Allow Unknown Fields', createInput(doc, 'checkbox', spec?.allowUnknownFields === true, (checked) => {
    updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
      draft.allowUnknownFields = checked;
    });
  })));

  appendInfoBlock(advanced, 'Metadata and per-edge overrides remain available when different selected edges need different settings than the shared controls above.');
  advanced.appendChild(createRow(doc, 'Metadata (JSON)', createTextarea(doc, formatJson(spec?.metadata), (value) => {
    try {
      const parsed = parseJsonObject(value, 'Metadata');
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        draft.metadata = parsed;
      });
    } catch (error) {
      reportError(error.message);
    }
  }, 6)));
  advanced.appendChild(createRow(doc, 'Per-edge Overrides (JSON)', createTextarea(doc, formatJsonArray(spec?.edges), (value) => {
    try {
      const parsed = parseJsonArray(value, 'Per-edge overrides');
      updateSpec(feature, finalizeChamferSpec, applySpec, (draft) => {
        draft.edges = parsed;
      });
    } catch (error) {
      reportError(error.message);
    }
  }, 8)));
}
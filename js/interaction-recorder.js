// js/interaction-recorder.js — Records user interactions as settled-state action steps
// Captures: orbit changes (start/end), tool activations, face/plane selections,
// feature operations, keyboard shortcuts, and 2D drawing actions.
// Only stores final settled states (e.g. orbit start→end, not every intermediate frame).
// Export as JSON array for Playwright/agent-based workflow debugging.

/**
 * @typedef {Object} RecordedStep
 * @property {number} seq       - Sequence number
 * @property {number} ts        - Timestamp (ms since recording start)
 * @property {string} type      - Action category
 * @property {Object} [data]    - Action-specific payload
 */

export class InteractionRecorder {
  constructor() {
    /** @type {RecordedStep[]} */
    this._steps = [];
    this._recording = false;
    this._startTime = 0;
    this._seq = 0;

    // Pending orbit drag (start position, stored on mousedown, flushed on mouseup)
    this._pendingOrbit = null;
  }

  // ---------------------------------------------------------------------------
  // Control
  // ---------------------------------------------------------------------------

  /** Start recording. Clears any previous steps. */
  start() {
    this._steps = [];
    this._seq = 0;
    this._startTime = performance.now();
    this._recording = true;
    this._pendingOrbit = null;
  }

  /** Stop recording and return the captured steps. */
  stop() {
    this._recording = false;
    this._pendingOrbit = null;
    return this.getSteps();
  }

  /** Whether the recorder is currently active. */
  get recording() { return this._recording; }

  /** Return a copy of all recorded steps so far. */
  getSteps() { return this._steps.slice(); }

  /** Export steps as a JSON string (pretty-printed). */
  exportJSON() { return JSON.stringify(this._steps, null, 2); }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Append a step (only when recording). */
  _push(type, data) {
    if (!this._recording) return;
    this._steps.push({
      seq: this._seq++,
      ts: Math.round(performance.now() - this._startTime),
      type,
      ...(data !== undefined ? { data } : {}),
    });
  }

  // ---------------------------------------------------------------------------
  // Orbit / Camera  (settled: record start + end, skip intermediate frames)
  // ---------------------------------------------------------------------------

  /** Call on orbit drag start (middle-mouse down or shift+drag). */
  orbitStart(theta, phi, radius, target) {
    if (!this._recording) return;
    this._pendingOrbit = { action: 'rotate', theta, phi, radius, target: { ...target } };
  }

  /** Call on pan drag start. */
  panStart(target) {
    if (!this._recording) return;
    this._pendingOrbit = { action: 'pan', target: { ...target } };
  }

  /** Call when orbit/pan drag ends (mouseup). Records start→end delta. */
  orbitEnd(theta, phi, radius, target) {
    if (!this._recording || !this._pendingOrbit) return;
    const start = this._pendingOrbit;
    this._push('camera', {
      action: start.action,
      from: { theta: start.theta, phi: start.phi, radius: start.radius, target: start.target },
      to: { theta, phi, radius, target: { ...target } },
    });
    this._pendingOrbit = null;
  }

  /** Record a discrete zoom step (scroll wheel). */
  zoom(radius, target) {
    this._push('camera', { action: 'zoom', radius, target: { ...target } });
  }

  // ---------------------------------------------------------------------------
  // Tool activation
  // ---------------------------------------------------------------------------

  /** A drawing / constraint tool was activated. */
  toolActivated(toolName) {
    this._push('tool', { name: toolName });
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  /** A 3D face was selected. */
  faceSelected(faceIndex, faceGroup, normal, sourceFeatureId) {
    this._push('select_face', { faceIndex, faceGroup, normal, sourceFeatureId });
  }

  /** A 3D face was deselected. */
  faceDeselected() {
    this._push('deselect_face');
  }

  /** An origin / construction plane was selected. */
  planeSelected(planeName) {
    this._push('select_plane', { plane: planeName });
  }

  /** A feature in the node tree was selected. */
  featureSelected(featureId, featureType, featureName) {
    this._push('select_feature', { id: featureId, type: featureType, name: featureName });
  }

  // ---------------------------------------------------------------------------
  // Feature operations
  // ---------------------------------------------------------------------------

  /** User started a new sketch on a plane/face. */
  sketchStarted(planeName, planeDef) {
    this._push('sketch_start', { plane: planeName, planeDef: planeDef || null });
  }

  /** User exited / finished a sketch. */
  sketchFinished(sketchFeatureId, entityCount) {
    this._push('sketch_finish', { sketchFeatureId, entityCount });
  }

  /** User double-clicked to edit an existing sketch. */
  sketchEditStarted(sketchFeatureId, sketchName) {
    this._push('sketch_edit_start', { sketchFeatureId, name: sketchName });
  }

  /** User finished editing an existing sketch (with recalculation). */
  sketchEditFinished(sketchFeatureId) {
    this._push('sketch_edit_finish', { sketchFeatureId });
  }

  /** Extrude / extrude-cut operation. */
  extrudeCreated(featureId, distance, isCut) {
    this._push('extrude', { featureId, distance, cut: isCut });
  }

  /** Revolve operation. */
  revolveCreated(featureId, angle) {
    this._push('revolve', { featureId, angle });
  }

  /** An auto-sketch was created from a selected face. */
  autoSketchFromFace(sketchFeatureId, faceIndex, vertexCount) {
    this._push('auto_sketch_from_face', { sketchFeatureId, faceIndex, vertexCount });
  }

  // ---------------------------------------------------------------------------
  // 2D Drawing actions (settled: entity creation, not intermediate hover)
  // ---------------------------------------------------------------------------

  /** A 2D entity was created (segment, circle, arc, etc.) during sketching. */
  entityCreated(entityType, details) {
    this._push('entity_created', { entityType, ...details });
  }

  /** A constraint was added. */
  constraintAdded(constraintType, details) {
    this._push('constraint_added', { constraintType, ...details });
  }

  /** Entities were deleted. */
  entitiesDeleted(count) {
    this._push('entities_deleted', { count });
  }

  // ---------------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------------

  /** A keyboard shortcut was triggered. */
  keyboardShortcut(key, action) {
    this._push('keyboard', { key, action });
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  /** User toggled a UI setting. */
  settingToggled(setting, value) {
    this._push('setting', { setting, value });
  }

  /** Generic user action (e.g. undo, redo, new, save, open). */
  uiAction(action, details) {
    this._push('ui_action', { action, ...(details || {}) });
  }

  /** Workspace mode changed. */
  workspaceChanged(mode) {
    this._push('workspace', { mode });
  }
}

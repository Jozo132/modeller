// js/interaction-recorder.js — Records user interactions as executable text action commands.
//
// Every recorded step is a text command string that can be typed into the
// command input (cmd-input) to replay the exact same user action.
// Recording captures only settled/final states — e.g. camera orbit stores
// the end position, not every intermediate frame.
//
// Usage:
//   recorder.start()            — begin recording
//   recorder.stop()             — stop and return steps
//   recorder.getCommands()      — get command strings
//   recorder.exportJSON()       — export { commands, meta }
//   Playback.run(app, commands) — replay commands into the app

const n4 = (v) => +v.toFixed(4);

/**
 * @typedef {Object} RecordedStep
 * @property {number} seq     - Sequence number
 * @property {number} ts      - Timestamp (ms since recording start)
 * @property {string} command - Executable text command
 */

export class InteractionRecorder {
  constructor() {
    /** @type {RecordedStep[]} */
    this._steps = [];
    this._recording = false;
    this._startTime = 0;
    this._seq = 0;
    this._pendingOrbit = null;
    // Buffered camera command — consecutive camera actions consolidate here
    // and only get flushed when a non-camera action arrives.
    this._pendingCamera = null;
  }

  // ---- Control ----

  start() {
    this._steps = [];
    this._seq = 0;
    this._startTime = performance.now();
    this._recording = true;
    this._pendingOrbit = null;
    this._pendingCamera = null;
  }

  stop() {
    this._recording = false;
    this._pendingOrbit = null;
    // Flush any trailing camera command so it isn't lost
    this._flushCamera();
    return this.getSteps();
  }

  get recording() { return this._recording; }

  getSteps() { return this._steps.slice(); }

  /** Return only the command strings. */
  getCommands() { return this._steps.map(s => s.command); }

  /** Export as JSON with commands and metadata. */
  exportJSON() {
    return JSON.stringify({
      version: 1,
      recorded: new Date().toISOString(),
      steps: this._steps,
    }, null, 2);
  }

  // ---- Internal ----

  /** Append a non-camera command. Flushes any pending camera first. */
  _push(command) {
    if (!this._recording) return;
    this._flushCamera();
    this._steps.push({
      seq: this._seq++,
      ts: Math.round(performance.now() - this._startTime),
      command,
    });
  }

  /** Buffer a camera command — replaces any previous buffered camera. */
  _pushCamera(command) {
    if (!this._recording) return;
    // Consolidate: overwrite the previous pending camera with the latest state
    this._pendingCamera = command;
  }

  /** Write the pending camera command to the step list (if any). */
  _flushCamera() {
    if (!this._pendingCamera) return;
    this._steps.push({
      seq: this._seq++,
      ts: Math.round(performance.now() - this._startTime),
      command: this._pendingCamera,
    });
    this._pendingCamera = null;
  }

  // ---- Camera (settled: only start→end, consolidated across sequences) ----

  orbitStart(theta, phi, radius, target) {
    if (!this._recording) return;
    this._pendingOrbit = { theta, phi, radius, target: { ...target } };
  }

  panStart(target) {
    if (!this._recording) return;
    this._pendingOrbit = { pan: true, target: { ...target } };
  }

  orbitEnd(theta, phi, radius, target) {
    if (!this._recording || !this._pendingOrbit) return;
    // Buffer — will be consolidated with any further camera actions
    this._pushCamera(`camera.set ${n4(theta)} ${n4(phi)} ${n4(radius)} ${n4(target.x)} ${n4(target.y)} ${n4(target.z)}`);
    this._pendingOrbit = null;
  }

  zoom(theta, phi, radius, target) {
    // Buffer — overwrites any pending camera
    this._pushCamera(`camera.set ${n4(theta)} ${n4(phi)} ${n4(radius)} ${n4(target.x)} ${n4(target.y)} ${n4(target.z)}`);
  }

  /** Record a full camera snapshot (e.g. for zoom where we need the full state). */
  cameraSnapshot(theta, phi, radius, target) {
    this._pushCamera(`camera.set ${n4(theta)} ${n4(phi)} ${n4(radius)} ${n4(target.x)} ${n4(target.y)} ${n4(target.z)}`);
  }

  // ---- Workspace ----

  workspaceChanged(mode) {
    this._push(`workspace ${mode}`);
  }

  // ---- Tool activation ----

  toolActivated(toolName) {
    this._push(`tool ${toolName}`);
  }

  // ---- Selection ----

  faceSelected(faceIndex, faceGroup, normal, sourceFeatureId) {
    const nStr = normal ? `${n4(normal.x)} ${n4(normal.y)} ${n4(normal.z)}` : '0 0 0';
    this._push(`select.face ${faceIndex} ${faceGroup != null ? faceGroup : faceIndex} ${nStr}${sourceFeatureId ? ` ${sourceFeatureId}` : ''}`);
  }

  faceDeselected() {
    this._push('deselect.face');
  }

  planeSelected(planeName) {
    this._push(`select.plane ${planeName}`);
  }

  featureSelected(featureId, featureType, featureName) {
    this._push(`select.feature ${featureId}`);
  }

  // ---- Sketch lifecycle ----

  sketchStarted(planeName, planeDef) {
    if (planeDef && planeName === 'FACE') {
      const o = planeDef.origin, nm = planeDef.normal, xa = planeDef.xAxis, ya = planeDef.yAxis;
      this._push(`sketch.start FACE ${n4(o.x)} ${n4(o.y)} ${n4(o.z)} ${n4(nm.x)} ${n4(nm.y)} ${n4(nm.z)} ${n4(xa.x)} ${n4(xa.y)} ${n4(xa.z)} ${n4(ya.x)} ${n4(ya.y)} ${n4(ya.z)}`);
    } else {
      this._push(`sketch.start ${planeName || 'XY'}`);
    }
  }

  sketchFinished(sketchFeatureId, entityCount) {
    this._push(`sketch.finish`);
  }

  sketchEditStarted(sketchFeatureId, sketchName) {
    this._push(`sketch.edit ${sketchFeatureId}`);
  }

  sketchEditFinished(sketchFeatureId) {
    this._push(`sketch.finish`);
  }

  // ---- Feature operations ----

  extrudeCreated(featureId, distance, isCut) {
    this._push(`extrude ${distance}${isCut ? ' cut' : ''}`);
  }

  revolveCreated(featureId, angle) {
    this._push(`revolve ${n4(angle)}`);
  }

  autoSketchFromFace(sketchFeatureId, faceIndex, vertexCount) {
    this._push(`sketch.from-face ${faceIndex}`);
  }

  // ---- 2D Drawing (entity creation as commands) ----

  entityCreated(entityType, details) {
    if (entityType === 'segment' && details) {
      this._push(`draw.line ${n4(details.x1)} ${n4(details.y1)} ${n4(details.x2)} ${n4(details.y2)}`);
    } else if (entityType === 'circle' && details) {
      this._push(`draw.circle ${n4(details.cx)} ${n4(details.cy)} ${n4(details.radius)}`);
    } else if (entityType === 'arc' && details) {
      this._push(`draw.arc ${n4(details.cx)} ${n4(details.cy)} ${n4(details.radius)} ${n4(details.startAngle)} ${n4(details.endAngle)}`);
    } else if (entityType === 'rectangle' && details) {
      this._push(`draw.rect ${n4(details.x1)} ${n4(details.y1)} ${n4(details.x2)} ${n4(details.y2)}`);
    } else {
      this._push(`draw.${entityType}${details ? ' ' + JSON.stringify(details) : ''}`);
    }
  }

  constraintAdded(constraintType, details) {
    this._push(`constraint ${constraintType}${details ? ' ' + JSON.stringify(details) : ''}`);
  }

  entitiesDeleted(count) {
    this._push(`delete ${count}`);
  }

  // ---- Keyboard / UI ----

  keyboardShortcut(key, action) {
    this._push(`key ${key}`);
  }

  settingToggled(setting, value) {
    this._push(`setting ${setting} ${value}`);
  }

  uiAction(action, details) {
    this._push(`ui ${action}`);
  }

  // ---- Click at world coordinates (2D sketch click) ----

  clickAt(x, y) {
    this._push(`click ${n4(x)} ${n4(y)}`);
  }
}


// ---------------------------------------------------------------------------
// Playback engine — executes recorded commands through _handleCommand()
// ---------------------------------------------------------------------------

export class PlaybackEngine {
  /**
   * @param {Object} app - The App instance (window.cadApp)
   * @param {Object} [options]
   * @param {number} [options.stepDelay=300] - ms to wait between commands
   * @param {Function} [options.onStep] - callback(seq, command) before each step
   * @param {Function} [options.onComplete] - callback() when playback finishes
   * @param {Function} [options.onError] - callback(seq, command, error) on failure
   */
  constructor(app, options = {}) {
    this._app = app;
    this._stepDelay = options.stepDelay || 300;
    this._onStep = options.onStep || null;
    this._onComplete = options.onComplete || null;
    this._onError = options.onError || null;
    this._running = false;
    this._aborted = false;
  }

  get running() { return this._running; }

  abort() { this._aborted = true; }

  /**
   * Play a list of command strings through the app's command handler.
   * @param {string[]} commands
   */
  async run(commands) {
    this._running = true;
    this._aborted = false;

    for (let i = 0; i < commands.length; i++) {
      if (this._aborted) break;
      const cmd = commands[i];
      if (this._onStep) this._onStep(i, cmd);

      try {
        this._app._handleCommand(cmd);
      } catch (err) {
        if (this._onError) this._onError(i, cmd, err);
        else console.error(`Playback error at step ${i}: ${cmd}`, err);
      }

      // Wait for the UI to settle
      await new Promise(r => setTimeout(r, this._stepDelay));
    }

    this._running = false;
    if (this._onComplete) this._onComplete();
  }
}


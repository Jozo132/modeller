// js/motion.js — 2D Motion Analysis Engine
//
// Pre-computes model states by sweeping a driving parameter (dimension or
// constraint value) from a start to end value across N steps.  Each frame
// records the full point state + selected output probe values.  Playback
// simply restores recorded states without re-solving.

import { state } from './state.js';
import { Scene } from './cad/index.js';

/**
 * @typedef {Object} MotionConfig
 * @property {object} driver      — the driving dimension or constraint object
 * @property {number} from        — start value
 * @property {number} to          — end value
 * @property {number} steps       — number of steps (frames = steps + 1)
 * @property {Array}  probes      — [{type:'point'|'dimension', target, label}]
 */

/**
 * @typedef {Object} MotionFrame
 * @property {number} step        — frame index (0..steps)
 * @property {number} driverValue — value of the driver at this frame
 * @property {Array<{x:number,y:number}>} points — all point positions [id→{x,y}]
 * @property {Object} probeValues — {label: value}
 */

export class MotionAnalysis {
  constructor() {
    /** @type {MotionConfig|null} */
    this.config = null;

    /** @type {MotionFrame[]} */
    this.frames = [];

    /** @type {boolean} */
    this.isRunning = false;

    /** @type {number} current frame index for playback */
    this.currentFrame = 0;

    /** @type {string|null} serialized scene backup for restore on stop */
    this._sceneBackup = null;
  }

  /**
   * Run the analysis: sweep driver from→to in N steps.
   * Captures geometry at each step.
   *
   * @param {MotionConfig} config
   * @returns {{ ok: boolean, error?: string }}
   */
  run(config) {
    this.config = config;
    this.frames = [];
    this.currentFrame = 0;

    const { driver, from, to, steps, probes } = config;
    if (!driver) return { ok: false, error: 'No driver selected' };
    if (steps < 1) return { ok: false, error: 'Steps must be ≥ 1' };

    // Save the scene state so we can restore after analysis
    const sceneBackup = JSON.stringify(state.scene.serialize());
    this._sceneBackup = sceneBackup;

    try {
      for (let i = 0; i <= steps; i++) {
        const t = steps === 0 ? 0 : i / steps;
        const driverValue = from + (to - from) * t;

        // Set the driver value
        this._setDriverValue(driver, driverValue);

        // Solve the model
        state.scene.solve({ maxIter: 500 });

        // Capture frame
        const frame = this._captureFrame(i, driverValue, probes);
        this.frames.push(frame);
      }
    } catch (e) {
      // Restore scene on error
      state.scene = Scene.deserialize(JSON.parse(sceneBackup));
      return { ok: false, error: e.message };
    }

    // Restore the scene to its original state
    state.scene = Scene.deserialize(JSON.parse(sceneBackup));
    state.scene.solve();

    // Re-link driver and probes to the restored scene objects
    this._relinkConfig();

    this.isRunning = true;
    // Apply frame 0
    this.seekFrame(0);
    return { ok: true };
  }

  /**
   * Re-link the config driver and probes to the current scene objects
   * (after scene deserialization replaces all objects).
   */
  _relinkConfig() {
    if (!this.config) return;
    const scene = state.scene;

    // Re-link driver
    const driverId = this.config._driverId;
    const driverIsDim = this.config._driverIsDim;
    if (driverIsDim) {
      this.config.driver = scene.dimensions.find(d => d.id === driverId) || null;
    } else {
      this.config.driver = scene.constraints.find(c => c.id === driverId) || null;
    }

    // Re-link probes
    for (const probe of this.config.probes) {
      if (probe.type === 'point') {
        probe.target = scene.points.find(p => p.id === probe._targetId) || null;
      } else if (probe.type === 'dimension') {
        probe.target = scene.dimensions.find(d => d.id === probe._targetId) || null;
      }
    }
  }

  /**
   * Set the driver value on the driving dimension or constraint.
   */
  _setDriverValue(driver, value) {
    if (driver.type === 'dimension') {
      // DimensionPrimitive — set formula to the numeric value
      driver.formula = value;
    } else if (driver.value !== undefined) {
      // Regular constraint with a value property
      driver.value = value;
    }
  }

  /**
   * Capture a single frame of geometry state.
   */
  _captureFrame(step, driverValue, probes) {
    const scene = state.scene;
    // Record all point positions
    const points = {};
    for (const p of scene.points) {
      points[p.id] = { x: p.x, y: p.y };
    }

    // Record probe values
    const probeValues = {};
    for (const probe of probes) {
      if (probe.type === 'point') {
        const pt = probe.target;
        if (pt) {
          probeValues[probe.label + '.x'] = pt.x;
          probeValues[probe.label + '.y'] = pt.y;
        }
      } else if (probe.type === 'dimension') {
        const dim = probe.target;
        if (dim) {
          probeValues[probe.label] = dim.value;
        }
      }
    }

    return { step, driverValue, points, probeValues };
  }

  /**
   * Apply a specific frame to the scene (for playback).
   */
  seekFrame(frameIndex) {
    if (!this.isRunning || this.frames.length === 0) return;
    frameIndex = Math.max(0, Math.min(frameIndex, this.frames.length - 1));
    this.currentFrame = frameIndex;

    const frame = this.frames[frameIndex];
    const scene = state.scene;

    // Apply recorded point positions directly
    for (const p of scene.points) {
      const recorded = frame.points[p.id];
      if (recorded) {
        p.x = recorded.x;
        p.y = recorded.y;
      }
    }

    // Sync dimension coordinates from sources
    for (const dim of scene.dimensions) {
      if (dim.sourceA) dim.syncFromSources();
    }
  }

  /**
   * Interpolate between two frames for smooth playback.
   * @param {number} t — fractional position (0..frames.length-1)
   */
  seekSmooth(t) {
    if (!this.isRunning || this.frames.length === 0) return;
    t = Math.max(0, Math.min(t, this.frames.length - 1));

    const i0 = Math.floor(t);
    const i1 = Math.min(i0 + 1, this.frames.length - 1);
    const frac = t - i0;

    const f0 = this.frames[i0];
    const f1 = this.frames[i1];
    const scene = state.scene;

    // Interpolate point positions
    for (const p of scene.points) {
      const r0 = f0.points[p.id];
      const r1 = f1.points[p.id];
      if (r0 && r1) {
        p.x = r0.x + (r1.x - r0.x) * frac;
        p.y = r0.y + (r1.y - r0.y) * frac;
      } else if (r0) {
        p.x = r0.x;
        p.y = r0.y;
      }
    }

    // Sync dimensions
    for (const dim of scene.dimensions) {
      if (dim.sourceA) dim.syncFromSources();
    }

    this.currentFrame = Math.round(t);
  }

  /**
   * Get interpolated probe values at a fractional position.
   */
  getProbeValuesAt(t) {
    if (!this.isRunning || this.frames.length === 0) return {};
    t = Math.max(0, Math.min(t, this.frames.length - 1));

    const i0 = Math.floor(t);
    const i1 = Math.min(i0 + 1, this.frames.length - 1);
    const frac = t - i0;

    const v0 = this.frames[i0].probeValues;
    const v1 = this.frames[i1].probeValues;

    const result = {};
    for (const key of Object.keys(v0)) {
      const a = v0[key] ?? 0;
      const b = v1[key] ?? a;
      result[key] = a + (b - a) * frac;
    }
    return result;
  }

  /**
   * Get the driver value at a fractional position.
   */
  getDriverValueAt(t) {
    if (!this.config) return 0;
    t = Math.max(0, Math.min(t, this.frames.length - 1));
    const i0 = Math.floor(t);
    const i1 = Math.min(i0 + 1, this.frames.length - 1);
    const frac = t - i0;
    return this.frames[i0].driverValue + (this.frames[i1].driverValue - this.frames[i0].driverValue) * frac;
  }

  /**
   * Stop the analysis and restore the scene to its original state.
   */
  stop() {
    if (!this.isRunning) return;
    // Restore scene from backup
    if (this._sceneBackup) {
      state.scene = Scene.deserialize(JSON.parse(this._sceneBackup));
      state.scene.solve();
    }
    this.isRunning = false;
    this.frames = [];
    this.config = null;
    this.currentFrame = 0;
    this._sceneBackup = null;
  }

  /**
   * Export probe data as CSV.
   */
  exportCSV() {
    if (this.frames.length === 0) return '';
    const probeKeys = Object.keys(this.frames[0].probeValues);
    const headers = ['Step', 'Driver', ...probeKeys];
    const rows = [headers.join(',')];
    for (const frame of this.frames) {
      const vals = [
        frame.step,
        frame.driverValue.toFixed(6),
        ...probeKeys.map(k => (frame.probeValues[k] ?? '').toString()),
      ];
      rows.push(vals.join(','));
    }
    return rows.join('\n');
  }
}

/** Singleton motion analysis instance */
export const motionAnalysis = new MotionAnalysis();

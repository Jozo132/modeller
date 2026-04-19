// js/telemetry.js — Performance telemetry for CAD modeller
//
// Tracks import time, cache hit rate, tessellation time, long tasks, and
// interaction latency.  Works in both main-thread and Web Worker contexts.
//
// Usage:
//   import { telemetry } from './telemetry.js';
//   telemetry.startTimer('import');
//   // ... do work ...
//   telemetry.endTimer('import');
//   telemetry.recordCacheHit();   // or recordCacheMiss()
//   console.log(telemetry.summary());

/**
 * @typedef {Object} TimerEntry
 * @property {string}  label      Human-readable label
 * @property {number}  startTime  High-resolution start (ms)
 * @property {number}  duration   Elapsed time (ms), set on end
 */

/**
 * @typedef {Object} TelemetrySummary
 * @property {TimerEntry[]}    timers         Completed timer entries
 * @property {number}          cacheHits      Number of cache hits
 * @property {number}          cacheMisses    Number of cache misses
 * @property {number}          cacheHitRate   Hit rate 0..1 (NaN if no lookups)
 * @property {LongTaskEntry[]} longTasks      Detected long tasks (>50 ms)
 * @property {number[]}        interactions   Interaction latency samples (ms)
 */

/**
 * @typedef {Object} LongTaskEntry
 * @property {number} startTime  When the task started (ms since origin)
 * @property {number} duration   How long it ran (ms)
 */

const _now = typeof performance !== 'undefined' && performance.now
  ? () => performance.now()
  : () => Date.now();

class Telemetry {
  constructor() {
    /** @type {Map<string, number>} label → startTime */
    this._pending = new Map();

    /** @type {TimerEntry[]} */
    this._timers = [];

    /** @type {number} */
    this._cacheHits = 0;

    /** @type {number} */
    this._cacheMisses = 0;

    /** @type {LongTaskEntry[]} */
    this._longTasks = [];

    /** @type {number[]} */
    this._interactions = [];

    /** @type {PerformanceObserver|null} */
    this._longTaskObserver = null;
  }

  // ── Timers ───────────────────────────────────────────────────────

  /**
   * Start a named timer.
   * @param {string} label
   */
  startTimer(label) {
    this._pending.set(label, _now());
  }

  /**
   * End a named timer and record the duration.
   * @param {string} label
   * @returns {number} duration in ms, or -1 if no matching start
   */
  endTimer(label) {
    const start = this._pending.get(label);
    if (start === undefined) return -1;
    this._pending.delete(label);
    const duration = _now() - start;
    this._timers.push({ label, startTime: start, duration });
    return duration;
  }

  /**
   * Record a completed timer directly.
   * Useful when the caller already measured the duration or when nested code
   * wants to avoid conflicting with the pending-timer label map.
   *
   * @param {string} label
   * @param {number} duration
   * @param {number} [startTime=_now()-duration]
   * @returns {number} recorded duration in ms
   */
  recordTimer(label, duration, startTime = _now() - duration) {
    const safeDuration = Math.max(0, Number(duration) || 0);
    const safeStart = Number.isFinite(startTime) ? startTime : _now() - safeDuration;
    this._timers.push({ label, startTime: safeStart, duration: safeDuration });
    return safeDuration;
  }

  /**
   * Convenience: run a synchronous function and time it.
   * @template T
   * @param {string} label
   * @param {() => T} fn
   * @returns {T}
   */
  time(label, fn) {
    this.startTimer(label);
    try {
      return fn();
    } finally {
      this.endTimer(label);
    }
  }

  /**
   * Convenience: run an async function and time it.
   * @template T
   * @param {string} label
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async timeAsync(label, fn) {
    this.startTimer(label);
    try {
      return await fn();
    } finally {
      this.endTimer(label);
    }
  }

  // ── Cache tracking ───────────────────────────────────────────────

  /** Record a cache hit. */
  recordCacheHit() {
    this._cacheHits++;
  }

  /** Record a cache miss. */
  recordCacheMiss() {
    this._cacheMisses++;
  }

  // ── Long tasks ───────────────────────────────────────────────────

  /**
   * Begin observing long tasks (>50 ms) via PerformanceObserver.
   * No-op in environments where PerformanceObserver is unavailable.
   */
  observeLongTasks() {
    if (this._longTaskObserver) return;
    if (typeof PerformanceObserver === 'undefined') return;
    try {
      this._longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this._longTasks.push({
            startTime: entry.startTime,
            duration: entry.duration,
          });
        }
      });
      this._longTaskObserver.observe({ type: 'longtask', buffered: true });
    } catch {
      // 'longtask' not supported — silently ignore
    }
  }

  /** Stop observing long tasks. */
  stopLongTaskObserver() {
    if (this._longTaskObserver) {
      this._longTaskObserver.disconnect();
      this._longTaskObserver = null;
    }
  }

  // ── Interaction latency ──────────────────────────────────────────

  /**
   * Record an interaction latency sample.
   * @param {number} latencyMs
   */
  recordInteraction(latencyMs) {
    this._interactions.push(latencyMs);
  }

  // ── Query / reset ────────────────────────────────────────────────

  /**
   * Return a frozen summary of all collected telemetry.
   * @returns {TelemetrySummary}
   */
  summary() {
    const total = this._cacheHits + this._cacheMisses;
    return Object.freeze({
      timers: this._timers.slice(),
      cacheHits: this._cacheHits,
      cacheMisses: this._cacheMisses,
      cacheHitRate: total > 0 ? this._cacheHits / total : NaN,
      longTasks: this._longTasks.slice(),
      interactions: this._interactions.slice(),
    });
  }

  /**
   * Return the recorded timers filtered by label prefix.
   * @param {string} prefix
   * @returns {TimerEntry[]}
   */
  timersFor(prefix) {
    return this._timers.filter(t => t.label.startsWith(prefix));
  }

  /** Reset all collected data. */
  reset() {
    this._pending.clear();
    this._timers.length = 0;
    this._cacheHits = 0;
    this._cacheMisses = 0;
    this._longTasks.length = 0;
    this._interactions.length = 0;
  }
}

/** Singleton telemetry instance. */
export const telemetry = new Telemetry();

export { Telemetry };

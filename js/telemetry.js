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
      residency: this.residencySummary(),
      gpu: this.gpuSummary(),
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
    this._residency = { hydrations: 0, evictions: 0, hits: 0, misses: 0, totalHydrationMs: 0 };
    this._gpu = { dispatches: 0, totalDispatchMs: 0, totalUploadMs: 0, totalReadbackMs: 0 };
  }

  // ── Residency tracking ───────────────────────────────────────────

  /** @type {{ hydrations: number, evictions: number, hits: number, misses: number, totalHydrationMs: number }} */
  _residency = { hydrations: 0, evictions: 0, hits: 0, misses: 0, totalHydrationMs: 0 };

  /** Record a residency cache hit (handle already hydrated). */
  recordResidencyHit() {
    this._residency.hits++;
  }

  /** Record a residency cache miss (needed hydration). */
  recordResidencyMiss() {
    this._residency.misses++;
  }

  /**
   * Record a hydration event.
   * @param {number} durationMs — time to hydrate from CBREP
   */
  recordHydration(durationMs) {
    this._residency.hydrations++;
    this._residency.totalHydrationMs += durationMs;
  }

  /**
   * Record an eviction event.
   * @param {number} [count=1] — number of handles evicted
   */
  recordEviction(count = 1) {
    this._residency.evictions += count;
  }

  // ── GPU dispatch tracking ────────────────────────────────────────

  /** @type {{ dispatches: number, totalDispatchMs: number, totalUploadMs: number, totalReadbackMs: number }} */
  _gpu = { dispatches: 0, totalDispatchMs: 0, totalUploadMs: 0, totalReadbackMs: 0 };

  /**
   * Record a GPU compute dispatch.
   * @param {number} dispatchMs — time from encode to onSubmittedWorkDone
   */
  recordGpuDispatch(dispatchMs) {
    this._gpu.dispatches++;
    this._gpu.totalDispatchMs += dispatchMs;
  }

  /**
   * Record a GPU upload (WASM → GPU).
   * @param {number} uploadMs
   */
  recordGpuUpload(uploadMs) {
    this._gpu.totalUploadMs += uploadMs;
  }

  /**
   * Record a GPU readback (GPU → CPU).
   * @param {number} readbackMs
   */
  recordGpuReadback(readbackMs) {
    this._gpu.totalReadbackMs += readbackMs;
  }

  /**
   * Return residency diagnostics summary.
   * @returns {{ hydrations: number, evictions: number, hits: number, misses: number, hitRate: number, avgHydrationMs: number }}
   */
  residencySummary() {
    const r = this._residency;
    const total = r.hits + r.misses;
    return {
      hydrations: r.hydrations,
      evictions: r.evictions,
      hits: r.hits,
      misses: r.misses,
      hitRate: total > 0 ? r.hits / total : 0,
      avgHydrationMs: r.hydrations > 0 ? r.totalHydrationMs / r.hydrations : 0,
    };
  }

  /**
   * Return GPU dispatch diagnostics summary.
   * @returns {{ dispatches: number, avgDispatchMs: number, totalUploadMs: number, totalReadbackMs: number }}
   */
  gpuSummary() {
    const g = this._gpu;
    return {
      dispatches: g.dispatches,
      avgDispatchMs: g.dispatches > 0 ? g.totalDispatchMs / g.dispatches : 0,
      totalUploadMs: g.totalUploadMs,
      totalReadbackMs: g.totalReadbackMs,
    };
  }
}

/** Singleton telemetry instance. */
export const telemetry = new Telemetry();

export { Telemetry };

// tests/_watchdog.mjs — self-imposed hard timeout for every test file.
//
// Import at the very top of a test file:
//
//     import './_watchdog.mjs';
//
// On import, this module arms a wall-clock watchdog. If the file has not
// exited within TEST_WATCHDOG_MS (default 30 000 ms, override via env),
// the process is killed from the *outside* via a detached child
// process — a plain in-process setTimeout cannot preempt a synchronous
// loop. The killer uses `process.kill(parentPid)`, which on Windows
// maps to TerminateProcess and on POSIX sends SIGTERM, either way
// guaranteeing the test dies at its budget regardless of what it is
// doing.
//
// This is an explicit quality gate: if a single test file cannot finish
// within 30 seconds, that is itself a defect. Fix the offending tests
// (tighten tolerances, cache heavy setup, split the file) rather than
// relaxing the limit.
//
// For visibility, this module also tracks wall-clock deltas between
// successive stdout lines. The in-process offender report fires only
// for async-yielding tests; sync-loop hangs are still killed by the
// external killer, just without the detailed report.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DEFAULT_MS = Number(process.env.TEST_WATCHDOG_MS || 30000);
const MAX_LABEL = 160;
const KEEP_TOP = 12;

const spans = [];
let lineBuf = '';
let lastMark = Date.now();
let lastLabel = '<startup>';

const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

function onLine(line) {
  const now = Date.now();
  const ms = now - lastMark;
  // Attribute the elapsed time to the label that *started* this span
  // (i.e. the line that was printed when the clock last reset). This
  // means "the work that happened after printing X took Y ms".
  spans.push({ label: lastLabel, ms });
  lastMark = now;
  lastLabel = line.slice(0, MAX_LABEL);
}

function wrapWrite(orig) {
  return function patchedWrite(chunk, enc, cb) {
    try {
      const s = typeof chunk === 'string'
        ? chunk
        : (chunk instanceof Uint8Array ? Buffer.from(chunk).toString('utf8') : String(chunk));
      let rest = s;
      let nl;
      while ((nl = rest.indexOf('\n')) >= 0) {
        const seg = rest.slice(0, nl);
        const full = lineBuf + seg;
        lineBuf = '';
        if (full.length > 0) onLine(full);
        rest = rest.slice(nl + 1);
      }
      lineBuf += rest;
    } catch { /* never let instrumentation break output */ }
    return orig(chunk, enc, cb);
  };
}

process.stdout.write = wrapWrite(origStdoutWrite);
process.stderr.write = wrapWrite(origStderrWrite);

const here = dirname(fileURLToPath(import.meta.url));
const killerScript = join(here, '_watchdog-killer.mjs');

// Spawn the external killer as a detached child whose stderr is
// inherited from the parent. Inheriting stderr lets the killer write
// a "KILLING pid N after Ts" banner to the same stream the parent is
// using, so even a pure-sync-loop hang (where the in-process offender
// report below can never fire) still leaves a visible trace.
//
// The grace window before the external kill is generous (2000 ms) so
// that *any* async-yielding test has plenty of time for the detailed
// in-process report to land before we TerminateProcess the parent.
const KILL_GRACE_MS = 2000;
let killer;
try {
  killer = spawn(
    process.execPath,
    [killerScript, String(process.pid), String(DEFAULT_MS + KILL_GRACE_MS), String(DEFAULT_MS)],
    { stdio: ['ignore', 'ignore', 'inherit'], detached: true },
  );
  if (killer.unref) killer.unref();
} catch { killer = null; }

process.on('exit', () => {
  if (killer && !killer.killed) {
    try { killer.kill(); } catch { /* ignore */ }
  }
});

const suiteStart = Date.now();
const watchdogTimer = setTimeout(() => {
  const nowMs = Date.now();
  const secs = ((nowMs - suiteStart) / 1000).toFixed(2);
  // The span currently in-flight hasn't been pushed yet: its label is
  // `lastLabel` and its elapsed is `nowMs - lastMark`. This is the most
  // important line of the report — it is almost always the test that
  // was stuck at the moment the watchdog fired.
  const inFlightMs = nowMs - lastMark;
  origStderrWrite(`\n\n!!! TEST FILE TIMEOUT after ${secs}s (limit ${DEFAULT_MS} ms)\n`);
  origStderrWrite('Each test file MUST complete within the watchdog budget; this one did not.\n\n');

  origStderrWrite(`IN-FLIGHT when killed: ${inFlightMs} ms elapsed since the last output line.\n`);
  origStderrWrite(`  last output: ${lastLabel}\n`);
  if (lineBuf && lineBuf.length > 0) {
    origStderrWrite(`  partial line being built: ${lineBuf.slice(0, MAX_LABEL)}\n`);
  }
  origStderrWrite(`  completed output lines so far: ${spans.length}\n\n`);

  // Chronological tail: the last few completed spans before the
  // in-flight one. Invaluable for "which test did we just pass and
  // which one got stuck" diagnosis.
  const TAIL = 20;
  const tail = spans.slice(-TAIL);
  if (tail.length) {
    origStderrWrite(`Last ${tail.length} completed output spans (chronological):\n`);
    for (const s of tail) {
      origStderrWrite(`  ${String(s.ms).padStart(7)} ms  ${s.label}\n`);
    }
    origStderrWrite('\n');
  }

  // Absolute slowest completed spans across the whole run. These are
  // the individual tests (or sub-blocks) that ate the budget.
  const topN = spans
    .filter((s) => s.label && s.label.trim().length > 0)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, KEEP_TOP);
  if (topN.length) {
    origStderrWrite(`Slowest ${topN.length} completed spans (worst offenders):\n`);
    for (const s of topN) {
      origStderrWrite(`  ${String(s.ms).padStart(7)} ms  ${s.label}\n`);
    }
    origStderrWrite('\n');
  }

  origStderrWrite('Fix the in-flight test and the slowest offenders (or split the file) and re-run.\n\n');
  process.exit(124);
}, DEFAULT_MS);
if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();

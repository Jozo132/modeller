// tools/bench-tests.mjs — Run every tests/test-*.js with a per-file timeout
// and a wall-clock measurement. Prints a compact table of (test, status,
// ms). A test that exceeds the timeout is killed with SIGKILL and reported
// as TIMEOUT. Exits non-zero if any test failed or timed out.
//
// Usage:
//   node tools/bench-tests.mjs                       # default 20 s timeout
//   node tools/bench-tests.mjs --timeout=10000       # 10 s timeout
//   node tools/bench-tests.mjs --filter=boolean      # only tests matching 'boolean'
//   node tools/bench-tests.mjs --exclude=nist,step   # skip anything matching
//   node tools/bench-tests.mjs --slowest=10          # sort output by duration

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const TESTS_DIR = join(ROOT, 'tests');

function parseArgs(argv) {
  // Default file-level deadline is 32 s; the per-file self-installed
  // watchdog (tests/_watchdog.mjs) fires at 30 s and dumps a detailed
  // offender report, so the bench gives it a 2 s grace before SIGKILL.
  const opts = { timeout: 32000, filter: null, exclude: [], slowest: 0 };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--timeout=')) opts.timeout = Number(a.slice(10));
    else if (a.startsWith('--filter=')) opts.filter = a.slice(9);
    else if (a.startsWith('--exclude=')) opts.exclude = a.slice(10).split(',').filter(Boolean);
    else if (a.startsWith('--slowest=')) opts.slowest = Number(a.slice(10));
    else throw new Error(`unknown arg ${a}`);
  }
  return opts;
}

function listTests() {
  return readdirSync(TESTS_DIR)
    .filter((f) => /^test-.*\.js$/.test(f))
    .sort();
}

function runOne(file, timeoutMs) {
  return new Promise((resolvePromise) => {
    const start = Date.now();
    const child = spawn(process.execPath, [join('tests', file)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stdoutTail = '';
    let stderrTail = '';
    const TAIL = 4096;
    child.stdout.on('data', (b) => { stdoutTail = (stdoutTail + b).slice(-TAIL); });
    child.stderr.on('data', (b) => { stderrTail = (stderrTail + b).slice(-TAIL); });

    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      const ms = Date.now() - start;
      let status;
      if (timedOut) status = 'TIMEOUT';
      else if (code === 0) status = 'PASS';
      else status = 'FAIL';
      resolvePromise({ file, status, ms, code, signal, stdoutTail, stderrTail });
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv);
  let files = listTests();
  if (opts.filter) files = files.filter((f) => f.includes(opts.filter));
  for (const excl of opts.exclude) files = files.filter((f) => !f.includes(excl));
  console.log(`Running ${files.length} test file(s) with --timeout=${opts.timeout}ms\n`);
  const results = [];
  for (const f of files) {
    process.stdout.write(`  ${f.padEnd(44)} `);
    const r = await runOne(f, opts.timeout);
    const marker = r.status === 'PASS' ? 'ok  ' : r.status === 'FAIL' ? 'FAIL' : 'TIME';
    console.log(`${marker}  ${String(r.ms).padStart(6)} ms`);
    results.push(r);
  }
  const failed = results.filter((r) => r.status !== 'PASS');
  const timedOut = results.filter((r) => r.status === 'TIMEOUT');

  console.log('\n=== Summary ===');
  console.log(`  total   : ${results.length}`);
  console.log(`  passed  : ${results.length - failed.length}`);
  console.log(`  failed  : ${failed.length - timedOut.length}`);
  console.log(`  timeouts: ${timedOut.length}`);
  const total = results.reduce((a, r) => a + r.ms, 0);
  console.log(`  wall    : ${total} ms\n`);

  if (opts.slowest > 0) {
    const top = [...results].sort((a, b) => b.ms - a.ms).slice(0, opts.slowest);
    console.log(`--- slowest ${top.length} ---`);
    for (const r of top) console.log(`  ${String(r.ms).padStart(6)} ms  ${r.status.padEnd(7)} ${r.file}`);
    console.log('');
  }

  if (failed.length) {
    console.log('--- failing / timing-out tests ---');
    for (const r of failed) {
      console.log(`\n=== ${r.file} (${r.status}, exit=${r.code}, signal=${r.signal}) ===`);
      if (r.stdoutTail) console.log('[stdout tail]\n' + r.stdoutTail);
      if (r.stderrTail) console.log('[stderr tail]\n' + r.stderrTail);
    }
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });

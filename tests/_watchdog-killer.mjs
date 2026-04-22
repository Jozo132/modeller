// tests/_watchdog-killer.mjs — External killer process for the test
// watchdog. Sleeps for the configured deadline, then prints a banner
// to the shared stderr and calls process.kill(parentPid). On Windows
// this maps to TerminateProcess, which preempts any synchronous loop
// in the parent — something an in-process setTimeout cannot do.
//
// Inheriting the parent's stderr via spawn({stdio:[..,'inherit']})
// means the banner from this killer lands in the same stream as the
// parent's output, so the developer sees *something* even when a
// synchronous CPU loop blocked the parent's own watchdog from firing.
const parentPid = Number(process.argv[2]);
const deadlineMs = Number(process.argv[3]);
const budgetMs = Number(process.argv[4]) || deadlineMs;
if (!Number.isFinite(parentPid) || parentPid <= 0) process.exit(0);
if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) process.exit(0);
setTimeout(() => {
  try {
    process.stderr.write(
      `\n\n!!! EXTERNAL WATCHDOG KILLING pid ${parentPid} after ${deadlineMs} ms ` +
      `(file budget ${budgetMs} ms)\n` +
      `The parent's in-process offender report did not fire — the event loop ` +
      `was blocked by a synchronous CPU loop. Look at the stdout tail above to ` +
      `see the last test that printed before the stall.\n\n`
    );
  } catch { /* ignore */ }
  try { process.kill(parentPid); } catch { /* parent already exited */ }
  process.exit(0);
}, deadlineMs);


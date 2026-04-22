// tests/_watchdog-killer.mjs — External killer process for the test
// watchdog. Sleeps for the configured deadline, then calls
// process.kill(parentPid). On Windows this maps to TerminateProcess,
// which preempts any synchronous loop in the parent — something an
// in-process setTimeout cannot do.
const parentPid = Number(process.argv[2]);
const deadlineMs = Number(process.argv[3]);
if (!Number.isFinite(parentPid) || parentPid <= 0) process.exit(0);
if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) process.exit(0);
setTimeout(() => {
  try { process.kill(parentPid); } catch { /* parent already exited */ }
  process.exit(0);
}, deadlineMs);

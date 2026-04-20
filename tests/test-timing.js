const now = typeof performance !== 'undefined' && performance.now
  ? () => performance.now()
  : () => Date.now();

export function startTiming() {
  return now();
}

export function formatTimingSuffix(startedAt, thresholdMs = 100) {
  const elapsedMs = now() - startedAt;
  if (elapsedMs <= thresholdMs) return '';

  const formatted = elapsedMs >= 1000
    ? elapsedMs.toFixed(0)
    : elapsedMs.toFixed(1);
  return ` (${formatted}ms)`;
}
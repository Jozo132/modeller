import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const TIMINGS_PATH = join(here, 'timings.json');
export const TIMING_UPDATE_THRESHOLD = 0.20;

export function timingFileKey(filePath) {
  return basename(filePath || '');
}

export function secondsFromMs(ms) {
  return Number((ms / 1000).toFixed(3));
}

export function shouldUpdateTiming(previousSeconds, nextSeconds) {
  if (typeof previousSeconds !== 'number' || !Number.isFinite(previousSeconds) || previousSeconds <= 0) {
    return true;
  }
  const diffRatio = Math.abs(nextSeconds - previousSeconds) / previousSeconds;
  return diffRatio > TIMING_UPDATE_THRESHOLD;
}

export function loadTimings() {
  if (!existsSync(TIMINGS_PATH)) return { timings: {}, raw: '' };
  const raw = readFileSync(TIMINGS_PATH, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) return { timings: {}, raw };
  const parsed = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { timings: {}, raw };

  const timings = {};
  for (const [file, seconds] of Object.entries(parsed)) {
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
      timings[file] = seconds;
    }
  }
  return { timings, raw };
}

export function mergeTimingResults(existingTimings, results) {
  const timings = { ...existingTimings };
  let updatedCount = 0;

  for (const result of results) {
    const key = timingFileKey(result.file);
    const nextSeconds = secondsFromMs(result.ms);
    if (shouldUpdateTiming(timings[key], nextSeconds)) {
      timings[key] = nextSeconds;
      updatedCount++;
    }
  }

  const sortedTimings = Object.fromEntries(
    Object.entries(timings).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  );
  return { timings: sortedTimings, updatedCount };
}

export function persistTimingResults(results) {
  const { timings: existingTimings, raw: previousRaw } = loadTimings();
  const { timings, updatedCount } = mergeTimingResults(existingTimings, results);
  const nextRaw = JSON.stringify(timings, null, 4) + '\n';
  const wroteFile = previousRaw !== nextRaw;
  if (wroteFile) writeFileSync(TIMINGS_PATH, nextRaw);
  return { timings, updatedCount, wroteFile };
}
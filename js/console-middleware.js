const MAX_CONSOLE_ENTRIES = 1000;
const CONSOLE_LEVELS = Object.freeze({
  debug: 10,
  log: 20,
  info: 30,
  warn: 40,
  error: 50,
});

const subscribers = new Set();
const entries = [];
let originals = null;
let installed = false;
let nextLine = 1;
const WINDOW_CAPTURE_FLAG = '__modellerConsoleWindowCaptureInstalled';
const WINDOW_API_KEY = '__modellerConsole';

function normalizeLevel(level) {
  return CONSOLE_LEVELS[level] !== undefined ? level : 'log';
}

function trimLocation(url) {
  if (!url) return 'unknown';
  try {
    const parsed = new URL(url, window.location.href);
    const path = parsed.pathname || url;
    return path.split('/').filter(Boolean).slice(-2).join('/') || parsed.host || url;
  } catch {
    return String(url).split('/').filter(Boolean).slice(-2).join('/') || String(url);
  }
}

function buildLocation(url, line, column) {
  if (!url && !line && !column) return null;
  return {
    url: url || '',
    line: Number(line) || 0,
    column: Number(column) || 0,
    display: [trimLocation(url), line || 0, column || 0].filter(Boolean).join(':'),
  };
}

function extractLocationFromStack(stack) {
  if (!stack) return null;
  const lines = String(stack)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (line.includes('console-middleware.js')) continue;
    let match = line.match(/(?:at\s+(?:.+?\s+\()?)(.+?):(\d+):(\d+)\)?$/);
    if (!match) match = line.match(/^(?:.*@)?(.+?):(\d+):(\d+)$/);
    if (match) {
      return buildLocation(match[1], match[2], match[3]);
    }
  }
  return null;
}

function notifySubscribers() {
  const snapshot = entries.slice();
  subscribers.forEach((subscriber) => {
    try {
      subscriber(snapshot);
    } catch {}
  });
}

function pushConsoleEntry(entry) {
  entries.push(entry);
  if (entries.length > MAX_CONSOLE_ENTRIES) {
    entries.splice(0, entries.length - MAX_CONSOLE_ENTRIES);
  }
  notifySubscribers();
}

function createConsoleEntry({
  level,
  args = [],
  source = 'console',
  stack = null,
  location = null,
}) {
  const timestampMs = Date.now();
  return {
    id: `console-entry-${timestampMs}-${nextLine}`,
    line: nextLine++,
    level: normalizeLevel(level),
    source,
    args,
    stack,
    location,
    timestampMs,
    timestamp: new Date(timestampMs).toISOString(),
  };
}

function captureConsoleCall(level, args) {
  const stack = new Error().stack || null;
  pushConsoleEntry(createConsoleEntry({
    level,
    args: Array.from(args),
    source: 'console',
    stack,
    location: extractLocationFromStack(stack),
  }));
}

function installWindowErrorCapture() {
  if (typeof window === 'undefined' || window[WINDOW_CAPTURE_FLAG]) return;
  window[WINDOW_CAPTURE_FLAG] = true;

  window.addEventListener('error', (event) => {
    const location = buildLocation(event.filename, event.lineno, event.colno)
      || extractLocationFromStack(event.error?.stack);
    const args = [];
    if (event.message) args.push(event.message);
    if (event.error) args.push(event.error);
    pushConsoleEntry(createConsoleEntry({
      level: 'error',
      args: args.length ? args : ['Unhandled error event'],
      source: 'window.error',
      stack: event.error?.stack || null,
      location,
    }));
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason === undefined
      ? 'Unhandled promise rejection (no reason provided)'
      : event.reason;
    const stack = reason && typeof reason === 'object' ? reason.stack || null : null;
    pushConsoleEntry(createConsoleEntry({
      level: 'error',
      args: ['Unhandled promise rejection', reason],
      source: 'window.unhandledrejection',
      stack,
      location: extractLocationFromStack(stack),
    }));
  });
}

export function installConsoleMiddleware() {
  if (installed || typeof console === 'undefined') return;
  installed = true;
  originals = {};
  ['debug', 'log', 'info', 'warn', 'error'].forEach((method) => {
    const original = typeof console[method] === 'function'
      ? console[method].bind(console)
      : null;
    originals[method] = original;
    if (!original) return;
    console[method] = (...args) => {
      captureConsoleCall(method, args);
      return original(...args);
    };
  });
  installWindowErrorCapture();
  if (typeof window !== 'undefined') {
    window[WINDOW_API_KEY] = {
      getEntries: () => getConsoleEntries(),
      clear: () => clearConsoleEntries(),
      subscribe: (listener) => subscribeConsoleEntries(listener),
    };
  }
}

export function getConsoleEntries() {
  return entries.slice();
}

export function clearConsoleEntries() {
  entries.length = 0;
  notifySubscribers();
}

export function subscribeConsoleEntries(listener) {
  if (typeof listener !== 'function') return () => {};
  subscribers.add(listener);
  listener(entries.slice());
  return () => subscribers.delete(listener);
}

export function getConsoleLevelPriority(level) {
  return CONSOLE_LEVELS[normalizeLevel(level)];
}

installConsoleMiddleware();

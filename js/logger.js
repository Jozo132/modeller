// js/logger.js — Lightweight logger for diagnostics
const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const config = {
  enabled: true,
  level: LEVELS.debug,
  scope: 'CAD-Modeller',
};

function format(level, args) {
  const ts = new Date().toISOString();
  return [`[${config.scope}]`, ts, level.toUpperCase(), ...args];
}

export function setLogEnabled(enabled) {
  config.enabled = !!enabled;
}

export function setLogLevel(level) {
  if (LEVELS[level] !== undefined) {
    config.level = LEVELS[level];
  }
}

export function debug(...args) {
  if (!config.enabled || config.level > LEVELS.debug) return;
  console.debug(...format('debug', args));
}

export function info(...args) {
  if (!config.enabled || config.level > LEVELS.info) return;
  console.info(...format('info', args));
}

export function warn(...args) {
  if (!config.enabled || config.level > LEVELS.warn) return;
  console.warn(...format('warn', args));
}

export function error(...args) {
  if (!config.enabled || config.level > LEVELS.error) return;
  console.error(...format('error', args));
}

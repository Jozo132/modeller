import {
  clearConsoleEntries,
  getConsoleEntries,
  getConsoleLevelPriority,
  subscribeConsoleEntries,
} from './console-middleware.js';

const CONSOLE_TREE_MAX_ITEMS = 100;
const CONSOLE_SCROLL_STICK_THRESHOLD_PX = 16;

function formatConsoleTime(timestampMs) {
  const date = new Date(timestampMs);
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function summarizeConsoleValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (value instanceof Date) return `Date ${value.toISOString()}`;
  if (Array.isArray(value)) return `Array(${value.length})`;
  if (value instanceof Map) return `Map(${value.size})`;
  if (value instanceof Set) return `Set(${value.size})`;
  if (typeof value === 'object') {
    const name = value?.constructor?.name;
    const keys = Object.keys(value || {});
    return `${name && name !== 'Object' ? `${name} ` : ''}{${keys.slice(0, 3).join(', ')}${keys.length > 3 ? ', …' : ''}}`;
  }
  return String(value);
}

function createConsoleValueNode(value, prettyPrint, seen = new WeakSet(), depth = 0) {
  const span = document.createElement('span');
  if (!prettyPrint) {
    span.className = 'console-value-text';
    const type = value === null ? 'null' : typeof value;
    span.classList.add(`console-value-${type === 'object' ? 'object' : type}`);
    span.textContent = summarizeConsoleValue(value);
    return span;
  }

  if (value === null) {
    span.className = 'console-value-text console-value-null';
    span.textContent = 'null';
    return span;
  }
  if (value === undefined) {
    span.className = 'console-value-text console-value-undefined';
    span.textContent = 'undefined';
    return span;
  }
  if (typeof value === 'string') {
    span.className = 'console-value-text console-value-string';
    span.textContent = JSON.stringify(value);
    return span;
  }
  if (typeof value === 'number') {
    span.className = 'console-value-text console-value-number';
    span.textContent = String(value);
    return span;
  }
  if (typeof value === 'boolean') {
    span.className = 'console-value-text console-value-boolean';
    span.textContent = String(value);
    return span;
  }
  if (typeof value === 'bigint') {
    span.className = 'console-value-text console-value-bigint';
    span.textContent = String(value);
    return span;
  }
  if (typeof value === 'symbol') {
    span.className = 'console-value-text console-value-symbol';
    span.textContent = value.toString();
    return span;
  }
  if (typeof value === 'function') {
    span.className = 'console-value-text console-value-function';
    span.textContent = `[Function ${value.name || 'anonymous'}]`;
    return span;
  }
  if (value instanceof Date) {
    span.className = 'console-value-text console-value-date';
    span.textContent = value.toISOString();
    return span;
  }
  if (value instanceof Error) {
    const details = document.createElement('details');
    details.className = 'console-tree';
    const summary = document.createElement('summary');
    summary.textContent = `${value.name}: ${value.message}`;
    details.appendChild(summary);
    const children = document.createElement('div');
    children.className = 'console-tree-children';
    if (value.stack) {
      value.stack.split('\n').forEach((line) => {
        const row = document.createElement('div');
        row.className = 'console-tree-item';
        row.textContent = line;
        children.appendChild(row);
      });
    }
    details.appendChild(children);
    return details;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      span.className = 'console-value-text console-value-undefined';
      span.textContent = '[Circular]';
      return span;
    }
    seen.add(value);
    const details = document.createElement('details');
    details.className = 'console-tree';
    if (depth < 1) details.open = true;
    const summary = document.createElement('summary');
    summary.textContent = summarizeConsoleValue(value);
    details.appendChild(summary);
    const children = document.createElement('div');
    children.className = 'console-tree-children';
    let items = [];
    try {
      if (Array.isArray(value)) {
        items = value.map((entry, index) => [index, entry]);
      } else if (value instanceof Map) {
        items = Array.from(value.entries());
      } else if (value instanceof Set) {
        items = Array.from(value.values()).map((entry, index) => [index, entry]);
      } else {
        items = Object.entries(value);
      }
    } catch {
      items = [['value', '[Uninspectable]']];
    }
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'console-tree-item';
      empty.textContent = '(empty)';
      children.appendChild(empty);
    } else {
      items.slice(0, CONSOLE_TREE_MAX_ITEMS).forEach(([key, entryValue]) => {
        const row = document.createElement('div');
        row.className = 'console-tree-item';
        const keyEl = document.createElement('span');
        keyEl.className = 'console-tree-key';
        keyEl.textContent = `${String(key)}:`;
        row.appendChild(keyEl);
        row.appendChild(createConsoleValueNode(entryValue, true, seen, depth + 1));
        children.appendChild(row);
      });
      if (items.length > CONSOLE_TREE_MAX_ITEMS) {
        const truncated = document.createElement('div');
        truncated.className = 'console-tree-item';
        truncated.textContent = `… ${items.length - CONSOLE_TREE_MAX_ITEMS} more`;
        children.appendChild(truncated);
      }
    }
    details.appendChild(children);
    seen.delete(value);
    return details;
  }

  span.className = 'console-value-text';
  span.textContent = String(value);
  return span;
}

class ConsoleViewController {
  constructor() {
    this._bound = false;
    this._open = false;
    this._isolated = false;
    this._filterLevel = 'all';
    this._prettyPrint = true;
    this._entriesCache = getConsoleEntries();
    this._onClearStatus = null;
    this._hiddenStates = new Map();
    this._view = null;
  }

  configure({ onClearStatus } = {}) {
    if (typeof onClearStatus === 'function') {
      this._onClearStatus = onClearStatus;
    }
    return this;
  }

  bind() {
    if (this._bound) return !!this._view;
    const root = document.getElementById('console-view');
    if (!root) return false;

    this._view = {
      root,
      count: document.getElementById('console-entry-count'),
      entries: document.getElementById('console-entries'),
      levelFilter: document.getElementById('console-level-filter'),
      prettyPrint: document.getElementById('console-pretty-print'),
      clearButton: document.getElementById('console-clear-btn'),
      closeButton: document.getElementById('console-close-btn'),
    };

    if (this._view.levelFilter) this._view.levelFilter.value = this._filterLevel;
    if (this._view.prettyPrint) this._view.prettyPrint.checked = this._prettyPrint;

    this._view.levelFilter?.addEventListener('change', () => {
      this._filterLevel = this._view.levelFilter.value;
      this.render();
    });
    this._view.prettyPrint?.addEventListener('change', () => {
      this._prettyPrint = !!this._view.prettyPrint.checked;
      this.render();
    });
    this._view.clearButton?.addEventListener('click', () => {
      clearConsoleEntries();
      this._onClearStatus?.();
    });
    this._view.closeButton?.addEventListener('click', () => this.close({ updateHash: this._isolated }));

    subscribeConsoleEntries((entries) => {
      this._entriesCache = entries;
      if (this._open) this.render();
    });

    this._bound = true;
    return true;
  }

  isOpen() {
    return this._open;
  }

  open({ isolate = false, updateHash = false } = {}) {
    if (!this.bind()) return;
    if (updateHash && window.location.hash !== '#console') {
      window.history.pushState(null, '', `${window.location.pathname}${window.location.search}#console`);
    }
    this._open = true;
    this._entriesCache = getConsoleEntries();
    document.body.classList.add('console-view-open');
    this._setIsolatedMode(isolate);
    this._view.root.setAttribute('aria-hidden', 'false');
    this.render();
  }

  close({ updateHash = false } = {}) {
    if (!this.bind()) return;
    this._open = false;
    document.body.classList.remove('console-view-open');
    this._setIsolatedMode(false);
    this._view.root.setAttribute('aria-hidden', 'true');
    if (updateHash && window.location.hash === '#console') {
      window.history.pushState(null, '', `${window.location.pathname}${window.location.search}`);
    }
  }

  syncWithLocation() {
    if (window.location.hash === '#console') {
      this.open({ isolate: true });
    } else if (this._isolated && this._open) {
      this.close();
    }
  }

  render() {
    if (!this.bind()) return;
    const threshold = this._filterLevel === 'all'
      ? -Infinity
      : getConsoleLevelPriority(this._filterLevel);
    const filteredEntries = this._entriesCache.filter((entry) => (
      threshold === -Infinity || getConsoleLevelPriority(entry.level) >= threshold
    ));

    if (this._view.count) {
      this._view.count.textContent = `${filteredEntries.length} / ${this._entriesCache.length} entries`;
    }

    const container = this._view.entries;
    if (!container) return;
    const shouldStickToBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - CONSOLE_SCROLL_STICK_THRESHOLD_PX;
    container.innerHTML = '';

    if (filteredEntries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'console-entry empty';
      empty.textContent = 'No console entries match the current filter.';
      container.appendChild(empty);
      return;
    }

    filteredEntries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = `console-entry level-${entry.level}`;

      const line = document.createElement('div');
      line.className = 'console-entry-line';
      line.textContent = String(entry.line);

      const time = document.createElement('div');
      time.className = 'console-entry-time';
      time.textContent = formatConsoleTime(entry.timestampMs);

      const level = document.createElement('div');
      level.className = 'console-entry-level';
      level.textContent = entry.level;

      const source = document.createElement('div');
      source.className = 'console-entry-source';
      source.textContent = entry.location?.display || entry.source;

      const message = document.createElement('div');
      message.className = 'console-entry-message';
      if (!entry.args.length) {
        message.textContent = '(no arguments)';
      } else {
        entry.args.forEach((arg) => {
          message.appendChild(createConsoleValueNode(arg, this._prettyPrint));
        });
      }

      row.appendChild(line);
      row.appendChild(time);
      row.appendChild(level);
      row.appendChild(source);
      row.appendChild(message);
      container.appendChild(row);
    });

    if (shouldStickToBottom) {
      container.scrollTop = container.scrollHeight;
    }
  }

  _setIsolatedMode(active) {
    if (this._isolated === active) return;
    this._isolated = active;
    document.body.classList.toggle('console-view-isolated', active);
    if (active) {
      this._hiddenStates.clear();
      ['startup-loading', 'quick-start'].forEach((id) => {
        const element = document.getElementById(id);
        if (!element) return;
        this._hiddenStates.set(element, element.classList.contains('hidden'));
        element.classList.add('hidden');
      });
      return;
    }
    this._hiddenStates.forEach((wasHidden, element) => {
      element.classList.toggle('hidden', wasHidden);
    });
    this._hiddenStates.clear();
  }
}

let sharedController = null;

export function getOrCreateConsoleViewController(options = {}) {
  if (!sharedController) {
    sharedController = new ConsoleViewController();
  }
  return sharedController.configure(options);
}

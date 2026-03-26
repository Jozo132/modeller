// js/history.js — Undo/Redo system using history-pointer replay
//
// Instead of maintaining two independent stacks, we keep a single linear
// history array and a pointer.  undo/redo simply move the pointer and
// restore the snapshot at that position.  takeSnapshot() appends a new
// entry after the pointer (discarding any redo-able entries beyond it),
// preserving deterministic replay.
//
// Each history node stores:
//   - scene + part serialisation (for full restore)
//   - stable selection keys active at time of snapshot
//
// The HistoryCache is consulted during replay so that unchanged segments
// do not require recomputation.

import { state } from './state.js';
import { Scene } from './cad/index.js';
import { Part } from './cad/Part.js';

// Reference to PartManager (set via setPartManager)
let _partManager = null;

// -----------------------------------------------------------------------
// History store — linear array + pointer
// -----------------------------------------------------------------------

/** @type {Array<string>} JSON-encoded history nodes */
let _history = [];

/** Index of the current node (-1 = empty) */
let _pointer = -1;

/**
 * Register the part manager so undo/redo can capture and restore part state.
 * @param {PartManager} pm - The application's PartManager instance
 */
export function setPartManager(pm) {
  _partManager = pm;
}

/**
 * Take a snapshot of the current scene (and part) for undo.
 * Appends after the current pointer and trims any entries beyond it (redo
 * branch is discarded when new work is recorded).
 */
export function takeSnapshot() {
  const snapshot = {
    scene: state.scene.serialize(),
    part: _partManager && _partManager.getPart() ? _partManager.serialize() : null,
    selectionKeys: state._stableSelectionKeys ? [...state._stableSelectionKeys] : [],
    timestamp: Date.now(),
  };

  // Discard anything beyond the current pointer (new branch)
  _history = _history.slice(0, _pointer + 1);

  _history.push(JSON.stringify(snapshot));

  // Enforce max-history limit
  if (_history.length > state._maxHistory) {
    _history.shift();
  }

  _pointer = _history.length - 1;

  // Keep legacy stacks in sync for any code that reads them
  state._undoStack = _history.slice(0, _pointer);
  state._redoStack = [];
}

/**
 * Undo the last operation — move pointer backward and restore.
 */
export function undo() {
  if (_pointer <= 0) return;
  _pointer--;
  _restoreAtPointer();
  state.emit('change');
}

/**
 * Redo the last undone operation — move pointer forward and restore.
 */
export function redo() {
  if (_pointer >= _history.length - 1) return;
  _pointer++;
  _restoreAtPointer();
  state.emit('change');
}

/**
 * Return the current history pointer index and total length.
 * @returns {{ pointer:number, length:number }}
 */
export function getHistoryInfo() {
  return { pointer: _pointer, length: _history.length };
}

/**
 * Move the pointer to an arbitrary position and restore.
 * Clamps to valid range. Used by the HistoryTree UI.
 * @param {number} index
 */
export function movePointer(index) {
  const target = Math.max(0, Math.min(index, _history.length - 1));
  if (target === _pointer || _history.length === 0) return;
  _pointer = target;
  _restoreAtPointer();
  state.emit('change');
}

// -----------------------------------------------------------------------
// Internal
// -----------------------------------------------------------------------

function _restoreAtPointer() {
  if (_pointer < 0 || _pointer >= _history.length) return;
  const snapshot = JSON.parse(_history[_pointer]);
  _restoreSnapshot(snapshot);

  // Keep legacy stacks approximately in sync
  state._undoStack = _history.slice(0, _pointer);
  state._redoStack = _history.slice(_pointer + 1);
}

function _restoreSnapshot(snapshot) {
  // Support both old format (plain scene data) and new format (scene + part)
  if (snapshot && snapshot.scene) {
    state.scene = Scene.deserialize(snapshot.scene);
    if (_partManager && snapshot.part) {
      _partManager.deserialize(snapshot.part);
    }
  } else {
    // Legacy format: snapshot is just scene data
    state.scene = Scene.deserialize(snapshot);
  }

  // Restore stable selection keys
  if (snapshot && snapshot.selectionKeys) {
    state._stableSelectionKeys = [...snapshot.selectionKeys];
  } else {
    state._stableSelectionKeys = [];
  }

  state.selectedEntities = [];
}

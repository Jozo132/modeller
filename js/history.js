// js/history.js — Undo/Redo system using Scene deep-copy snapshots
import { state } from './state.js';
import { Scene } from './cad/index.js';
import { Part } from './cad/Part.js';

// Reference to PartManager (set via setPartManager)
let _partManager = null;

/**
 * Register the part manager so undo/redo can capture and restore part state.
 * @param {PartManager} pm - The application's PartManager instance
 */
export function setPartManager(pm) {
  _partManager = pm;
}

/**
 * Take a snapshot of the current scene (and part) for undo.
 */
export function takeSnapshot() {
  const snapshot = {
    scene: state.scene.serialize(),
    part: _partManager && _partManager.getPart() ? _partManager.serialize() : null,
  };
  state._undoStack.push(JSON.stringify(snapshot));
  if (state._undoStack.length > state._maxHistory) state._undoStack.shift();
  state._redoStack = [];
}

/**
 * Undo the last operation.
 */
export function undo() {
  if (state._undoStack.length === 0) return;
  // Save current state to redo
  const current = {
    scene: state.scene.serialize(),
    part: _partManager && _partManager.getPart() ? _partManager.serialize() : null,
  };
  state._redoStack.push(JSON.stringify(current));
  // Restore previous state
  const prev = JSON.parse(state._undoStack.pop());
  _restoreSnapshot(prev);
  state.emit('change');
}

/**
 * Redo the last undone operation.
 */
export function redo() {
  if (state._redoStack.length === 0) return;
  const current = {
    scene: state.scene.serialize(),
    part: _partManager && _partManager.getPart() ? _partManager.serialize() : null,
  };
  state._undoStack.push(JSON.stringify(current));
  const next = JSON.parse(state._redoStack.pop());
  _restoreSnapshot(next);
  state.emit('change');
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
  state.selectedEntities = [];
}

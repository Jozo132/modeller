// js/history.js — Undo/Redo system using Scene deep-copy snapshots
import { state } from './state.js';
import { Scene } from './cad/index.js';

/**
 * Take a snapshot of the current scene for undo.
 */
export function takeSnapshot() {
  const data = state.scene.serialize();
  state._undoStack.push(JSON.stringify(data));
  if (state._undoStack.length > state._maxHistory) state._undoStack.shift();
  state._redoStack = [];
}

/**
 * Undo the last operation.
 */
export function undo() {
  if (state._undoStack.length === 0) return;
  // Save current state to redo
  const current = state.scene.serialize();
  state._redoStack.push(JSON.stringify(current));
  // Restore previous state
  const prev = JSON.parse(state._undoStack.pop());
  _restoreScene(prev);
  state.emit('change');
}

/**
 * Redo the last undone operation.
 */
export function redo() {
  if (state._redoStack.length === 0) return;
  const current = state.scene.serialize();
  state._undoStack.push(JSON.stringify(current));
  const next = JSON.parse(state._redoStack.pop());
  _restoreScene(next);
  state.emit('change');
}

function _restoreScene(data) {
  state.scene = Scene.deserialize(data);
  state.selectedEntities = [];
}

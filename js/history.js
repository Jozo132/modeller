// js/history.js — Undo/Redo system using deep-copy snapshots
import { state } from './state.js';
import { Line, Circle, Arc, Polyline, TextEntity, Dimension, Rectangle } from './entities/index.js';

/**
 * Take a snapshot of all entities for undo.
 */
export function takeSnapshot() {
  const data = state.entities.map(e => serializeEntity(e));
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
  const current = state.entities.map(e => serializeEntity(e));
  state._redoStack.push(JSON.stringify(current));
  // Restore previous state
  const prev = JSON.parse(state._undoStack.pop());
  restoreEntities(prev);
  state.emit('change');
}

/**
 * Redo the last undone operation.
 */
export function redo() {
  if (state._redoStack.length === 0) return;
  const current = state.entities.map(e => serializeEntity(e));
  state._undoStack.push(JSON.stringify(current));
  const next = JSON.parse(state._redoStack.pop());
  restoreEntities(next);
  state.emit('change');
}

export function serializeEntity(e) {
  return { ...e.serialize(), id: e.id };
}

function restoreEntities(dataArray) {
  state.entities = [];
  state.selectedEntities = [];
  for (const d of dataArray) {
    const entity = deserializeEntity(d);
    if (entity) state.entities.push(entity);
  }
}

export function deserializeEntity(d) {
  let entity;
  switch (d.type) {
    case 'LINE':
      entity = new Line(d.x1, d.y1, d.x2, d.y2);
      break;
    case 'CIRCLE':
      entity = new Circle(d.cx, d.cy, d.radius);
      break;
    case 'ARC':
      entity = new Arc(d.cx, d.cy, d.radius, d.startAngle, d.endAngle);
      break;
    case 'LWPOLYLINE':
      if (d.points) {
        entity = new Polyline(d.points, d.closed);
      } else {
        entity = new Rectangle(d.x1, d.y1, d.x2, d.y2);
      }
      break;
    case 'TEXT':
      entity = new TextEntity(d.x, d.y, d.text, d.height);
      entity.rotation = d.rotation || 0;
      break;
    case 'DIMENSION':
      entity = new Dimension(d.x1, d.y1, d.x2, d.y2, d.offset);
      break;
    default:
      return null;
  }
  entity.layer = d.layer || '0';
  entity.color = d.color || null;
  return entity;
}

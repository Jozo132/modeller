// js/state.js — Global application state (singleton)
import { Scene } from './cad/index.js';

const LAYER_COLORS = [
  '#9CDCFE', '#ff0000', '#ffff00', '#00ff00', '#00ffff',
  '#0000ff', '#ff00ff', '#808080', '#c0c0c0', '#ff8000',
];

class AppState {
  constructor() {
    /** The parametric scene — all primitives + constraints live here */
    this.scene = new Scene();

    this.layers = [
      { name: '0', color: '#9CDCFE', visible: true, locked: false },
    ];
    this.activeLayer = '0';
    this.activeTool = 'select';
    this.snapEnabled = true;
    this.orthoEnabled = false;
    this.constructionMode = false;
    this.gridVisible = true;
    this.gridSize = 10;

    // Selection (primitives)
    this.selectedEntities = [];

    // History (undo/redo)
    this._undoStack = [];
    this._redoStack = [];
    this._maxHistory = 50;

    // Listeners
    this._listeners = {};
  }

  // --- Compatibility shim ---
  // Many parts of the app iterate state.entities — redirect to shapes
  get entities() {
    return [...this.scene.shapes()];
  }

  // --- Event system ---
  on(event, fn) {
    (this._listeners[event] ||= []).push(fn);
  }

  off(event, fn) {
    const arr = this._listeners[event];
    if (arr) this._listeners[event] = arr.filter(f => f !== fn);
  }

  emit(event, data) {
    (this._listeners[event] || []).forEach(fn => fn(data));
  }

  // --- Entity management (works with primitives) ---
  addEntity(entity) {
    entity.layer = this.activeLayer;
    // Push into the appropriate scene collection
    switch (entity.type) {
      case 'segment':   if (!this.scene.segments.includes(entity)) this.scene.segments.push(entity); break;
      case 'circle':    if (!this.scene.circles.includes(entity)) this.scene.circles.push(entity); break;
      case 'arc':       if (!this.scene.arcs.includes(entity)) this.scene.arcs.push(entity); break;
      case 'text':      if (!this.scene.texts.includes(entity)) this.scene.texts.push(entity); break;
      case 'dimension': if (!this.scene.dimensions.includes(entity)) this.scene.dimensions.push(entity); break;
      case 'point':     if (!this.scene.points.includes(entity)) this.scene.points.push(entity); break;
    }
    this.emit('entity:add', entity);
    this.emit('change');
  }

  removeEntity(entity) {
    this.scene.removePrimitive(entity);
    this.emit('entity:remove', entity);
    this.emit('change');
  }

  clearAll() {
    this.scene.clear();
    this.selectedEntities = [];
    this._undoStack = [];
    this._redoStack = [];
    this.emit('change');
  }

  // --- Selection ---
  select(entity) {
    if (!entity.selected) {
      entity.selected = true;
      this.selectedEntities.push(entity);
      this.emit('selection:change', this.selectedEntities);
    }
  }

  deselect(entity) {
    entity.selected = false;
    this.selectedEntities = this.selectedEntities.filter(e => e !== entity);
    this.emit('selection:change', this.selectedEntities);
  }

  clearSelection() {
    for (const e of this.selectedEntities) e.selected = false;
    this.selectedEntities = [];
    this.emit('selection:change', this.selectedEntities);
  }

  // --- Layers ---
  addLayer(name, color) {
    if (this.layers.find(l => l.name === name)) return false;
    color = color || LAYER_COLORS[this.layers.length % LAYER_COLORS.length];
    this.layers.push({ name, color, visible: true, locked: false });
    this.emit('layers:change');
    return true;
  }

  getLayerColor(layerName) {
    const layer = this.layers.find(l => l.name === layerName);
    return layer ? layer.color : '#9CDCFE';
  }

  isLayerVisible(layerName) {
    const layer = this.layers.find(l => l.name === layerName);
    return layer ? layer.visible : true;
  }

  // Set tool
  setTool(toolName) {
    this.activeTool = toolName;
    this.emit('tool:change', toolName);
  }
}

// Singleton
export const state = new AppState();
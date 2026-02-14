// js/state.js — Global application state (singleton)

const LAYER_COLORS = [
  '#ffffff', '#ff0000', '#ffff00', '#00ff00', '#00ffff',
  '#0000ff', '#ff00ff', '#808080', '#c0c0c0', '#ff8000',
];

class AppState {
  constructor() {
    this.entities = [];
    this.layers = [
      { name: '0', color: '#ffffff', visible: true, locked: false },
    ];
    this.activeLayer = '0';
    this.activeTool = 'select';
    this.snapEnabled = true;
    this.orthoEnabled = false;
    this.gridVisible = true;
    this.gridSize = 10;

    // Selection
    this.selectedEntities = [];

    // History (undo/redo)
    this._undoStack = [];
    this._redoStack = [];
    this._maxHistory = 50;

    // Listeners
    this._listeners = {};
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

  // --- Entity management ---
  addEntity(entity) {
    entity.layer = this.activeLayer;
    this.entities.push(entity);
    this.emit('entity:add', entity);
    this.emit('change');
  }

  removeEntity(entity) {
    const idx = this.entities.indexOf(entity);
    if (idx >= 0) {
      this.entities.splice(idx, 1);
      this.emit('entity:remove', entity);
      this.emit('change');
    }
  }

  clearAll() {
    this.entities = [];
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
    return layer ? layer.color : '#ffffff';
  }

  isLayerVisible(layerName) {
    const layer = this.layers.find(l => l.name === layerName);
    return layer ? layer.visible : true;
  }

  // --- History ---
  snapshot() {
    // Save a JSON snapshot of entities
    const data = this.entities.map(e => ({
      proto: e.constructor.name,
      props: { ...e },
    }));
    this._undoStack.push(JSON.stringify(data));
    if (this._undoStack.length > this._maxHistory) this._undoStack.shift();
    this._redoStack = [];
  }

  // Set tool
  setTool(toolName) {
    this.activeTool = toolName;
    this.emit('tool:change', toolName);
  }
}

// Singleton
export const state = new AppState();

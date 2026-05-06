// js/snap.js — Snap system: grid, endpoint, midpoint, center, quadrant

import { state } from './state.js';
import { debug, warn } from './logger.js';

const SNAP_RADIUS = 15; // screen pixels

// --- Spatial hash for snap points ---
// Rebuilt lazily when entity count changes. World-space grid
// lets findSnap check only nearby snap points instead of all entities.
const _SNAP_CELL = 10; // world units per cell
let _snapGrid = null;   // Map<string, Array<{x,y,type}>>
let _snapGridCount = -1; // entity count when grid was built

function _rebuildSnapGrid() {
  const grid = new Map();
  for (const entity of state.scene.shapes()) {
    if (!entity.visible) continue;
    if (!state.isLayerVisible(entity.layer)) continue;
    const snaps = entity.getSnapPoints();
    if (!Array.isArray(snaps)) continue;
    for (const snap of snaps) {
      if (!snap || !Number.isFinite(snap.x) || !Number.isFinite(snap.y)) continue;
      const indexedSnap = snap.target ? snap : { ...snap, target: entity };
      const cx = Math.floor(snap.x / _SNAP_CELL);
      const cy = Math.floor(snap.y / _SNAP_CELL);
      const key = `${cx},${cy}`;
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(indexedSnap);
    }
  }
  for (const point of state.scene.points || []) {
    if (!point?.standalone || !point.visible) continue;
    if (!state.isLayerVisible(point.layer)) continue;
    const snap = { x: point.x, y: point.y, type: 'endpoint', target: point };
    const cx = Math.floor(snap.x / _SNAP_CELL);
    const cy = Math.floor(snap.y / _SNAP_CELL);
    const key = `${cx},${cy}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(snap);
  }
  _snapGrid = grid;
}

/** Invalidate the snap grid so it will be rebuilt on next findSnap call. */
export function invalidateSnapGrid() {
  _snapGridCount = -1;
}

/**
 * Find the best snap point near a screen position.
 * @param {number} sx - screen X
 * @param {number} sy - screen Y
 * @param {import('./viewport.js').Viewport} viewport
 * @returns {{x: number, y: number, type: string} | null}
 */
export function findSnap(sx, sy, viewport) {
  const opts = arguments[3] || {};
  if (!state.snapEnabled) return null;

  // Lazily rebuild the spatial grid when entities change
  const count = state.scene.entityCount();
  if (!_snapGrid || _snapGridCount !== count) {
    _rebuildSnapGrid();
    _snapGridCount = count;
  }

  const world = viewport.screenToWorld(sx, sy);
  // Convert snap radius to world coordinates for grid query
  const worldRadius = SNAP_RADIUS / viewport.zoom;

  let bestDist = Infinity;
  let bestSnap = null;

  // Query only nearby grid cells
  const minCX = Math.floor((world.x - worldRadius) / _SNAP_CELL);
  const maxCX = Math.floor((world.x + worldRadius) / _SNAP_CELL);
  const minCY = Math.floor((world.y - worldRadius) / _SNAP_CELL);
  const maxCY = Math.floor((world.y + worldRadius) / _SNAP_CELL);

  for (let cx = minCX; cx <= maxCX; cx++) {
    for (let cy = minCY; cy <= maxCY; cy++) {
      const snaps = _snapGrid.get(`${cx},${cy}`);
      if (!snaps) continue;
      for (const snap of snaps) {
        if (!snap || !Number.isFinite(snap.x) || !Number.isFinite(snap.y)) continue;
        // Quick world-space rejection before expensive screen transform
        const dx = snap.x - world.x;
        const dy = snap.y - world.y;
        if (dx > worldRadius || dx < -worldRadius || dy > worldRadius || dy < -worldRadius) continue;
        const s = viewport.worldToScreen(snap.x, snap.y);
        const dist = Math.hypot(s.x - sx, s.y - sy);
        if (dist < SNAP_RADIUS && dist < bestDist) {
          bestDist = dist;
          bestSnap = snap;
        }
      }
    }
  }

  // Origin snap — always available as a high-priority snap
  const originScreen = viewport.worldToScreen(0, 0);
  const originDist = Math.hypot(originScreen.x - sx, originScreen.y - sy);
  if (originDist < SNAP_RADIUS && originDist < bestDist) {
    bestDist = originDist;
    bestSnap = { x: 0, y: 0, type: 'origin' };
  }

  if (bestSnap) return bestSnap;

  for (const entity of state.scene.shapes()) {
    if (!entity.visible || !state.isLayerVisible(entity.layer)) continue;
    const edgeSnap = _edgeSnapForEntity(entity, world.x, world.y);
    if (!edgeSnap) continue;
    const s = viewport.worldToScreen(edgeSnap.x, edgeSnap.y);
    const dist = Math.hypot(s.x - sx, s.y - sy);
    if (dist < SNAP_RADIUS && dist < bestDist) {
      bestDist = dist;
      bestSnap = edgeSnap;
    }
  }

  if (bestSnap) return bestSnap;

  // Grid snap (optional bypass for Ctrl-drag)
  if (!opts.ignoreGridSnap) {
    const gs = state.gridSize;
    const gx = Math.round(world.x / gs) * gs;
    const gy = Math.round(world.y / gs) * gs;
    const gs_screen = viewport.worldToScreen(gx, gy);
    const gridDist = Math.hypot(gs_screen.x - sx, gs_screen.y - sy);
    if (gridDist < SNAP_RADIUS) {
      return { x: gx, y: gy, type: 'grid' };
    }
  }

  return null;
}

function _edgeSnapForEntity(entity, wx, wy) {
  if (entity.type === 'segment') {
    const dx = entity.x2 - entity.x1;
    const dy = entity.y2 - entity.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 1e-18) return null;
    let t = ((wx - entity.x1) * dx + (wy - entity.y1) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    return {
      x: entity.x1 + t * dx,
      y: entity.y1 + t * dy,
      type: 'edge',
      target: entity,
    };
  }
  if (entity.type === 'circle' || entity.type === 'arc') {
    const angle = Math.atan2(wy - entity.cy, wx - entity.cx);
    if (entity.type === 'arc' && !entity._angleInArc(angle)) return null;
    return {
      x: entity.cx + Math.cos(angle) * entity.radius,
      y: entity.cy + Math.sin(angle) * entity.radius,
      type: entity.type === 'circle' ? 'circle_edge' : 'arc_edge',
      target: entity,
    };
  }
  return null;
}

/**
 * Apply ortho constraint to a point relative to a base point.
 * @param {number} bx - base X (world)
 * @param {number} by - base Y (world)
 * @param {number} px - candidate X (world)
 * @param {number} py - candidate Y (world)
 * @returns {{x: number, y: number}}
 */
export function applyOrtho(bx, by, px, py) {
  if (!state.orthoEnabled) return { x: px, y: py };
  const dx = Math.abs(px - bx);
  const dy = Math.abs(py - by);
  if (dx > dy) {
    return { x: px, y: by };
  } else {
    return { x: bx, y: py };
  }
}

/**
 * Get the final snapped/constrained world position.
 */
export function getSnappedPosition(sx, sy, viewport, basePoint = null) {
  const opts = arguments[4] || {};
  const snap = findSnap(sx, sy, viewport, opts);
  let world;
  if (snap) {
    world = { x: snap.x, y: snap.y };
  } else {
    world = viewport.screenToWorld(sx, sy);
  }
  if (basePoint && state.orthoEnabled) {
    const ortho = applyOrtho(basePoint.x, basePoint.y, world.x, world.y);
    world = ortho;
  }
  if (snap && snap.type !== 'grid') {
    debug('Snap hit', { type: snap.type, x: snap.x.toFixed(2), y: snap.y.toFixed(2) });
  }
  return { world, snap };
}

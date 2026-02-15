// js/snap.js — Snap system: grid, endpoint, midpoint, center, quadrant

import { state } from './state.js';
import { debug, warn } from './logger.js';

const SNAP_RADIUS = 15; // screen pixels

/**
 * Find the best snap point near a screen position.
 * @param {number} sx - screen X
 * @param {number} sy - screen Y
 * @param {import('./viewport.js').Viewport} viewport
 * @returns {{x: number, y: number, type: string} | null}
 */
export function findSnap(sx, sy, viewport) {
  const opts = arguments[3] || {};
  const t0 = performance.now();
  if (!state.snapEnabled) return null;

  const world = viewport.screenToWorld(sx, sy);
  let bestDist = Infinity;
  let bestSnap = null;

  // Entity snap points
  for (const entity of state.entities) {
    if (!entity.visible) continue;
    if (!state.isLayerVisible(entity.layer)) continue;
    const snaps = entity.getSnapPoints();
    for (const snap of snaps) {
      const s = viewport.worldToScreen(snap.x, snap.y);
      const dist = Math.hypot(s.x - sx, s.y - sy);
      if (dist < SNAP_RADIUS && dist < bestDist) {
        bestDist = dist;
        bestSnap = snap;
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

  // Grid snap (optional bypass for Ctrl-drag)
  if (!opts.ignoreGridSnap) {
    const gs = state.gridSize;
    const gx = Math.round(world.x / gs) * gs;
    const gy = Math.round(world.y / gs) * gs;
    const gs_screen = viewport.worldToScreen(gx, gy);
    const gridDist = Math.hypot(gs_screen.x - sx, gs_screen.y - sy);
    if (gridDist < SNAP_RADIUS) {
      const dt = performance.now() - t0;
      if (dt > 8) {
        warn('findSnap slow (grid)', { ms: dt.toFixed(2), entities: state.entities.length });
      }
      return { x: gx, y: gy, type: 'grid' };
    }
  }

  const dt = performance.now() - t0;
  if (dt > 8) {
    warn('findSnap slow', { ms: dt.toFixed(2), entities: state.entities.length });
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

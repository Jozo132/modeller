// js/renderer.js — Canvas renderer: grid, entities, selection highlights, crosshair

import { state } from './state.js';
import { error as logError } from './logger.js';

const SNAP_MARKER_SIZE = 6;
const FULLY_CONSTRAINED_COLOR = '#4FC1FF';

export class Renderer {
  constructor(viewport) {
    this.vp = viewport;
    this.ctx = viewport.ctx;

    // Snap indicator
    this.snapPoint = null;   // {x, y, type}
    this.cursorWorld = null;  // {x, y}  current cursor in world

    // Temp entity for tool preview
    this.previewEntities = [];
    this.hoverEntity = null;
  }

  /** Full redraw */
  render() {
    try {
      const { ctx, vp } = this;
      ctx.clearRect(0, 0, vp.width, vp.height);
      ctx.fillStyle = '#1e1e1e';
      ctx.fillRect(0, 0, vp.width, vp.height);

      // Compute fully-constrained sets for this frame
      this._fc = _computeFullyConstrained(state.scene);

      if (state.gridVisible) this._drawGrid();
      this._drawAxes();
      this._drawEntities();
      this._drawPoints();
      this._drawConstraints();
      this._drawPreview();
      this._drawSnapIndicator();
      this._drawCrosshair();
    } catch (err) {
      logError('Renderer.render failed', err);
    }
  }

  // --- Grid ---
  _drawGrid() {
    const { ctx, vp } = this;
    const baseGridSize = state.gridSize;

    // Determine visible world bounds
    const tl = vp.screenToWorld(0, 0);
    const br = vp.screenToWorld(vp.width, vp.height);
    const worldLeft = Math.min(tl.x, br.x);
    const worldRight = Math.max(tl.x, br.x);
    const worldTop = Math.max(tl.y, br.y);
    const worldBottom = Math.min(tl.y, br.y);

    // Keep grid readable at all zoom levels by adapting world step
    let gridStep = baseGridSize;
    while (gridStep * vp.zoom < 8) {
      gridStep *= 2;
    }

    // Minor grid
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 0.5;
    const startX = Math.floor(worldLeft / gridStep) * gridStep;
    const startY = Math.floor(worldBottom / gridStep) * gridStep;

    ctx.beginPath();
    for (let x = startX; x <= worldRight; x += gridStep) {
      const s = vp.worldToScreen(x, 0);
      ctx.moveTo(s.x, 0);
      ctx.lineTo(s.x, vp.height);
    }
    for (let y = startY; y <= worldTop; y += gridStep) {
      const s = vp.worldToScreen(0, y);
      ctx.moveTo(0, s.y);
      ctx.lineTo(vp.width, s.y);
    }
    ctx.stroke();

    // Major grid (every 5 units)
    const majorGs = gridStep * 5;
    if (majorGs * vp.zoom >= 20) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 0.5;
      const startMX = Math.floor(worldLeft / majorGs) * majorGs;
      const startMY = Math.floor(worldBottom / majorGs) * majorGs;
      ctx.beginPath();
      for (let x = startMX; x <= worldRight; x += majorGs) {
        const s = vp.worldToScreen(x, 0);
        ctx.moveTo(s.x, 0);
        ctx.lineTo(s.x, vp.height);
      }
      for (let y = startMY; y <= worldTop; y += majorGs) {
        const s = vp.worldToScreen(0, y);
        ctx.moveTo(0, s.y);
        ctx.lineTo(vp.width, s.y);
      }
      ctx.stroke();
    }
  }

  // --- Axes ---
  _drawAxes() {
    const { ctx, vp } = this;
    const origin = vp.worldToScreen(0, 0);

    // X axis (red)
    ctx.strokeStyle = 'rgba(255,80,80,0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, origin.y);
    ctx.lineTo(vp.width, origin.y);
    ctx.stroke();

    // Y axis (green)
    ctx.strokeStyle = 'rgba(80,255,80,0.4)';
    ctx.beginPath();
    ctx.moveTo(origin.x, 0);
    ctx.lineTo(origin.x, vp.height);
    ctx.stroke();
  }

  // --- Entities ---
  _drawEntities() {
    const { ctx, vp } = this;
    for (const entity of state.entities) {
      if (!entity.visible) continue;
      if (!state.isLayerVisible(entity.layer)) continue;

      const baseColor = entity.color || state.getLayerColor(entity.layer);
      const color = this._fc.entities.has(entity)
        ? FULLY_CONSTRAINED_COLOR
        : baseColor;

      if (entity.selected) {
        ctx.strokeStyle = '#00bfff';
        ctx.fillStyle = '#00bfff';
        ctx.lineWidth = 2;
      } else if (entity === this.hoverEntity) {
        ctx.strokeStyle = '#7fd8ff';
        ctx.fillStyle = '#7fd8ff';
        ctx.lineWidth = Math.max(1.5, (entity.lineWidth || 1) + 0.5);
      } else {
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = entity.lineWidth;
      }

      entity.draw(ctx, vp);

      // Draw selection grips
      if (entity.selected) {
        this._drawGrips(entity);
      }
    }
  }

  _drawGrips(entity) {
    const { ctx, vp } = this;
    const snaps = entity.getSnapPoints().filter(s => s.type === 'endpoint' || s.type === 'center');
    ctx.fillStyle = '#00bfff';
    for (const snap of snaps) {
      const s = vp.worldToScreen(snap.x, snap.y);
      ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
    }
  }

  // --- Points (shared vertices) ---
  _drawPoints() {
    const { ctx, vp } = this;
    const scene = state.scene;
    ctx.save();
    for (const pt of scene.points) {
      const s = vp.worldToScreen(pt.x, pt.y);
      const isHover = pt === this.hoverEntity;
      // Show all points that are shared, fixed, selected, or hovered
      const refs = scene.shapesUsingPoint(pt).length;
      if (refs <= 1 && !pt.selected && !pt.fixed && !isHover) continue;
      const isFCPt = this._fc.points.has(pt);
      const r = pt.selected ? 5.5 : (isHover ? 5 : ((pt.fixed || isFCPt) ? 4.5 : 3.5));
      ctx.fillStyle = pt.selected ? '#00bfff'
        : isHover ? '#7fd8ff'
        : isFCPt ? FULLY_CONSTRAINED_COLOR
        : pt.fixed ? '#ff6644'
        : 'rgba(255,255,0,0.55)';
      ctx.beginPath();
      ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
      ctx.fill();
      // Draw a ring around selected / hovered points for clarity
      if (pt.selected || isHover) {
        ctx.strokeStyle = pt.selected ? '#00bfff' : '#7fd8ff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // --- Constraint indicators ---
  _drawConstraints() {
    const { ctx, vp } = this;
    const scene = state.scene;
    ctx.save();
    ctx.font = '10px Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (const c of scene.constraints) {
      // Dimension constraints draw themselves — skip the small icon
      if (c.type === 'dimension') continue;
      const pts = c.involvedPoints();
      if (pts.length === 0) continue;
      // Draw a small icon near the centroid of involved points
      let cx = 0, cy = 0;
      for (const p of pts) { cx += p.x; cy += p.y; }
      cx /= pts.length; cy /= pts.length;
      const s = vp.worldToScreen(cx, cy);
      // Offset a bit so it doesn't overlap geometry
      const ox = s.x + 12, oy = s.y - 10;

      ctx.fillStyle = c.error() < 1e-4 ? 'rgba(0,230,118,0.7)' : 'rgba(255,100,60,0.8)';
      const label = _constraintLabel(c.type);
      ctx.fillText(label, ox, oy);
    }
    ctx.restore();
  }

  // --- Preview (ghost entities being drawn) ---
  _drawPreview() {
    const { ctx, vp } = this;
    if (this.previewEntities.length === 0) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(0,191,255,0.6)';
    ctx.fillStyle = 'rgba(0,191,255,0.6)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);
    for (const entity of this.previewEntities) {
      entity.draw(ctx, vp);
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  // --- Snap indicator ---
  _drawSnapIndicator() {
    if (!this.snapPoint) return;
    const { ctx, vp } = this;
    const s = vp.worldToScreen(this.snapPoint.x, this.snapPoint.y);
    const sz = SNAP_MARKER_SIZE;

    ctx.save();
    ctx.strokeStyle = '#ffff00';
    ctx.lineWidth = 1.5;

    switch (this.snapPoint.type) {
      case 'endpoint':
        ctx.strokeRect(s.x - sz, s.y - sz, sz * 2, sz * 2);
        break;
      case 'midpoint':
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - sz);
        ctx.lineTo(s.x + sz, s.y + sz);
        ctx.lineTo(s.x - sz, s.y + sz);
        ctx.closePath();
        ctx.stroke();
        break;
      case 'center':
        ctx.beginPath();
        ctx.arc(s.x, s.y, sz, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(s.x - sz, s.y); ctx.lineTo(s.x + sz, s.y);
        ctx.moveTo(s.x, s.y - sz); ctx.lineTo(s.x, s.y + sz);
        ctx.stroke();
        break;
      case 'quadrant':
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - sz);
        ctx.lineTo(s.x + sz, s.y);
        ctx.lineTo(s.x, s.y + sz);
        ctx.lineTo(s.x - sz, s.y);
        ctx.closePath();
        ctx.stroke();
        break;
      case 'grid':
        ctx.beginPath();
        ctx.moveTo(s.x - sz, s.y); ctx.lineTo(s.x + sz, s.y);
        ctx.moveTo(s.x, s.y - sz); ctx.lineTo(s.x, s.y + sz);
        ctx.stroke();
        break;
    }
    ctx.restore();
  }

  // --- Crosshair at cursor ---
  _drawCrosshair() {
    if (!this.cursorWorld) return;
    const { ctx, vp } = this;
    const s = vp.worldToScreen(this.cursorWorld.x, this.cursorWorld.y);

    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 0.5;
    ctx.setLineDash([]);
    const gap = 10;
    ctx.beginPath();
    // Horizontal
    ctx.moveTo(0, s.y);
    ctx.lineTo(s.x - gap, s.y);
    ctx.moveTo(s.x + gap, s.y);
    ctx.lineTo(vp.width, s.y);
    // Vertical
    ctx.moveTo(s.x, 0);
    ctx.lineTo(s.x, s.y - gap);
    ctx.moveTo(s.x, s.y + gap);
    ctx.lineTo(s.x, vp.height);
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Recursive DOF propagation for fully-constrained evaluation.
// Starts from fixed points and follows constraints + shared-point topology.
//
// Per-point state: xLock / yLock (axis determined), radialSources (set of
// FC points with known-distance), onFCLine (on a line whose two endpoints
// are FC).  A point is FC when enough independent constraints remove both
// degrees of freedom.
//
// Per-segment state: dirKnown (angle is determined, from H/V/Parallel/
// Perpendicular/Angle), lenKnown (length is determined, from Length/
// EqualLength/Distance between its endpoints).
//
// Key derived rule: dirKnown + lenKnown + one endpoint FC → other FC.
// ---------------------------------------------------------------------------

function _computeFullyConstrained(scene) {
  // --- per-point state ---
  const ps = new Map();
  for (const pt of scene.points) {
    ps.set(pt, {
      xLock: !!pt.fixed,
      yLock: !!pt.fixed,
      radials: new Set(), // FC points we have a known distance from
      onFCLine: false,
    });
  }

  // --- per-segment state ---
  const ss = new Map();
  for (const seg of scene.segments) {
    ss.set(seg, { dirKnown: false, lenKnown: false });
  }

  // --- helpers ---
  const isFC = (s) => {
    if (!s) return false;
    if (s.xLock && s.yLock) return true;
    const axes = (s.xLock ? 1 : 0) + (s.yLock ? 1 : 0);
    if (axes >= 1 && (s.radials.size >= 1 || s.onFCLine)) return true;
    if (s.radials.size >= 2) return true;
    if (s.onFCLine && s.radials.size >= 1) return true;
    return false;
  };
  const markFC = (s) => {
    if (!s) return false;
    let ch = false;
    if (!s.xLock) { s.xLock = true; ch = true; }
    if (!s.yLock) { s.yLock = true; ch = true; }
    return ch;
  };

  // --- fixed-point iteration ---
  let changed = true;
  let safety = 100;
  while (changed && safety-- > 0) {
    changed = false;

    for (const c of scene.constraints) {
      switch (c.type) {

        case 'fixed': {
          const s = ps.get(c.pt);
          if (s && markFC(s)) changed = true;
          break;
        }

        case 'coincident': {
          const sa = ps.get(c.ptA), sb = ps.get(c.ptB);
          if (sa && sb) {
            if (sa.xLock && !sb.xLock) { sb.xLock = true; changed = true; }
            if (sb.xLock && !sa.xLock) { sa.xLock = true; changed = true; }
            if (sa.yLock && !sb.yLock) { sb.yLock = true; changed = true; }
            if (sb.yLock && !sa.yLock) { sa.yLock = true; changed = true; }
            if (isFC(sa) && !isFC(sb) && markFC(sb)) changed = true;
            if (isFC(sb) && !isFC(sa) && markFC(sa)) changed = true;
          }
          break;
        }

        case 'horizontal': {
          const si = ss.get(c.seg);
          if (si && !si.dirKnown) { si.dirKnown = true; changed = true; }
          const s1 = ps.get(c.seg.p1), s2 = ps.get(c.seg.p2);
          if (s1 && s2) {
            if (s1.yLock && !s2.yLock) { s2.yLock = true; changed = true; }
            if (s2.yLock && !s1.yLock) { s1.yLock = true; changed = true; }
          }
          break;
        }

        case 'vertical': {
          const si = ss.get(c.seg);
          if (si && !si.dirKnown) { si.dirKnown = true; changed = true; }
          const s1 = ps.get(c.seg.p1), s2 = ps.get(c.seg.p2);
          if (s1 && s2) {
            if (s1.xLock && !s2.xLock) { s2.xLock = true; changed = true; }
            if (s2.xLock && !s1.xLock) { s1.xLock = true; changed = true; }
          }
          break;
        }

        case 'parallel':
        case 'perpendicular':
        case 'angle': {
          const siA = ss.get(c.segA), siB = ss.get(c.segB);
          if (siA && siB) {
            if (siA.dirKnown && !siB.dirKnown) { siB.dirKnown = true; changed = true; }
            if (siB.dirKnown && !siA.dirKnown) { siA.dirKnown = true; changed = true; }
          }
          break;
        }

        case 'length': {
          const si = ss.get(c.seg);
          if (si && !si.lenKnown) { si.lenKnown = true; changed = true; }
          break;
        }

        case 'equal_length': {
          const siA = ss.get(c.segA), siB = ss.get(c.segB);
          if (siA && siB) {
            if (siA.lenKnown && !siB.lenKnown) { siB.lenKnown = true; changed = true; }
            if (siB.lenKnown && !siA.lenKnown) { siA.lenKnown = true; changed = true; }
          }
          break;
        }

        case 'distance': {
          const sa = ps.get(c.ptA), sb = ps.get(c.ptB);
          if (sa && sb) {
            if (isFC(sa) && !sb.radials.has(c.ptA)) { sb.radials.add(c.ptA); changed = true; }
            if (isFC(sb) && !sa.radials.has(c.ptB)) { sa.radials.add(c.ptB); changed = true; }
          }
          // Also mark any segment between these endpoints as length-known
          for (const seg of scene.segments) {
            const si = ss.get(seg);
            if (!si || si.lenKnown) continue;
            if ((seg.p1 === c.ptA && seg.p2 === c.ptB) || (seg.p1 === c.ptB && seg.p2 === c.ptA)) {
              si.lenKnown = true; changed = true;
            }
          }
          break;
        }

        case 'on_line': {
          const sp = ps.get(c.pt);
          const s1 = ps.get(c.seg.p1), s2 = ps.get(c.seg.p2);
          if (sp && s1 && s2 && isFC(s1) && isFC(s2) && !sp.onFCLine) {
            sp.onFCLine = true; changed = true;
          }
          break;
        }

        case 'on_circle': {
          const sp = ps.get(c.pt), sc = ps.get(c.circle.center);
          if (sp && sc && isFC(sc) && !sp.radials.has(c.circle.center)) {
            sp.radials.add(c.circle.center); changed = true;
          }
          break;
        }

        case 'midpoint': {
          const sp = ps.get(c.pt);
          const s1 = ps.get(c.seg.p1), s2 = ps.get(c.seg.p2);
          if (sp && s1 && s2) {
            if (isFC(s1) && isFC(s2) && !isFC(sp) && markFC(sp)) changed = true;
            if (isFC(sp) && isFC(s1) && !isFC(s2) && markFC(s2)) changed = true;
            if (isFC(sp) && isFC(s2) && !isFC(s1) && markFC(s1)) changed = true;
          }
          break;
        }

        // tangent, radius — don't directly lock point DOF
        default: break;
      }

      // Handle dimension constraints (duck-typed, not using standard fields)
      if (c.type === 'dimension' && c.isConstraint && c.sourceA) {
        if (c.dimType === 'distance' && c.sourceA.type === 'point' && c.sourceB && c.sourceB.type === 'point') {
          const sa = ps.get(c.sourceA), sb = ps.get(c.sourceB);
          if (sa && sb) {
            if (isFC(sa) && !sb.radials.has(c.sourceA)) { sb.radials.add(c.sourceA); changed = true; }
            if (isFC(sb) && !sa.radials.has(c.sourceB)) { sa.radials.add(c.sourceB); changed = true; }
          }
        } else if (c.dimType === 'distance' && c.sourceA.type === 'segment' && !c.sourceB) {
          const si = ss.get(c.sourceA);
          if (si && !si.lenKnown) { si.lenKnown = true; changed = true; }
        } else if (c.dimType === 'angle' && c.sourceA.type === 'segment' && c.sourceB && c.sourceB.type === 'segment') {
          const siA = ss.get(c.sourceA), siB = ss.get(c.sourceB);
          if (siA && siB) {
            if (siA.dirKnown && !siB.dirKnown) { siB.dirKnown = true; changed = true; }
            if (siB.dirKnown && !siA.dirKnown) { siA.dirKnown = true; changed = true; }
          }
        }
      }
    }

    // --- derived segment rules ---
    for (const seg of scene.segments) {
      const si = ss.get(seg);
      if (!si) continue;
      const s1 = ps.get(seg.p1), s2 = ps.get(seg.p2);
      if (!s1 || !s2) continue;

      // dir + len + one FC endpoint → other fully determined
      if (si.dirKnown && si.lenKnown) {
        if (isFC(s1) && !isFC(s2) && markFC(s2)) changed = true;
        if (isFC(s2) && !isFC(s1) && markFC(s1)) changed = true;
      }

      // len + one FC endpoint (no dir) → other has radial
      if (si.lenKnown && !si.dirKnown) {
        if (isFC(s1) && !s2.radials.has(seg.p1)) { s2.radials.add(seg.p1); changed = true; }
        if (isFC(s2) && !s1.radials.has(seg.p2)) { s1.radials.add(seg.p2); changed = true; }
      }
    }
  }

  // --- build result sets ---
  const fcPoints = new Set();
  for (const [pt, s] of ps) { if (isFC(s)) fcPoints.add(pt); }

  const fcEntities = new Set();
  for (const seg of scene.segments) {
    if (fcPoints.has(seg.p1) && fcPoints.has(seg.p2)) fcEntities.add(seg);
  }
  for (const circ of scene.circles) {
    if (fcPoints.has(circ.center)) fcEntities.add(circ);
  }
  for (const arc of scene.arcs) {
    if (fcPoints.has(arc.center)) fcEntities.add(arc);
  }

  return { points: fcPoints, entities: fcEntities };
}

// Map constraint type to a short display label
function _constraintLabel(type) {
  const map = {
    coincident: '⊙', distance: '↔', fixed: '⊕',
    horizontal: 'H', vertical: 'V',
    parallel: '∥', perpendicular: '⊥', angle: '∠',
    equal_length: '=L', length: 'L',
    radius: 'R', tangent: 'T',
    on_line: '—·', on_circle: '○·', midpoint: 'M',
  };
  return map[type] || type;
}
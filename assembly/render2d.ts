// assembly/render2d.ts — 2D entity rendering via command buffer
// Renders segments, circles, arcs, and points on the XY plane (z=0).

import { Mat4, Color } from "./math";
import { CommandBuffer } from "./commands";
import { EntityStore, Dimension2D, DIM_LINEAR, DIM_HORIZONTAL, DIM_VERTICAL, DIM_ANGLE, FLAG_VISIBLE, FLAG_SELECTED, FLAG_CONSTRUCTION, FLAG_HOVER, FLAG_FIXED, FLAG_PREVIEW } from "./entities";

const CIRCLE_SEGMENTS: i32 = 64;
const CROSSHAIR_EXTENT: f32 = 10000.0;

// Dashed line parameters for construction geometry
const DASH_LENGTH: f32 = 6.0;
const GAP_LENGTH: f32 = 4.0;
// Skip step for dashed circles/arcs (every N tessellation segments)
const DASH_STEP: i32 = 4;  // draw 2 segments, skip 2 → ~50% duty cycle

// Dimension arrowhead parameters
const ARROW_SIZE_RATIO: f32 = 0.15;  // fraction of dimension line length
const MAX_ARROW_SIZE: f32 = 3.0;     // world-unit cap
const ARROW_HALF_WIDTH: f32 = 0.3;   // width-to-length ratio of arrowhead

// Model matrix for entity plane (transforms local 2D to world 3D)
let entityModelMatrix: Mat4 = Mat4.identity();
// Whether we're rendering on a 3D sketch plane (requires depth testing)
let entityModelMatrixIs3D: bool = false;

export function setEntityModelMatrix(
  m00: f32, m01: f32, m02: f32, m03: f32,
  m10: f32, m11: f32, m12: f32, m13: f32,
  m20: f32, m21: f32, m22: f32, m23: f32,
  m30: f32, m31: f32, m32: f32, m33: f32
): void {
  entityModelMatrix = Mat4.fromValues(
    m00, m01, m02, m03,
    m10, m11, m12, m13,
    m20, m21, m22, m23,
    m30, m31, m32, m33
  );
  entityModelMatrixIs3D = true;
}

export function resetEntityModelMatrix(): void {
  entityModelMatrix = Mat4.identity();
  entityModelMatrixIs3D = false;
}

/**
 * Render all 2D entities into the command buffer.
 * Entities are drawn on the entity model plane (default: XY plane at z=0).
 */
export function render2DEntities(cmd: CommandBuffer, vp: Mat4, entities: EntityStore): void {
  cmd.emitSetProgram(1); // line/point shader
  // In 3D sketch mode, enable depth testing so entities interact properly
  // with solid geometry. In pure 2D mode, disable for flat overlay.
  cmd.emitSetDepthTest(entityModelMatrixIs3D);

  // Multiply model matrix with view-projection to get final MVP
  const mvp = vp.multiply(entityModelMatrix);

  // --- Segments ---
  for (let i: i32 = 0; i < entities.segments.length; i++) {
    const seg = unchecked(entities.segments[i]);
    if (!(seg.flags & FLAG_VISIBLE)) continue;

    const selected = (seg.flags & FLAG_SELECTED) != 0;
    const hover = (seg.flags & FLAG_HOVER) != 0;
    const construction = (seg.flags & FLAG_CONSTRUCTION) != 0;
    const preview = (seg.flags & FLAG_PREVIEW) != 0;

    if (selected) {
      cmd.emitSetColor(0.0, 0.749, 1.0, 1.0); // #00bfff
    } else if (hover) {
      cmd.emitSetColor(0.498, 0.847, 1.0, 1.0); // #7fd8ff
    } else if (construction) {
      cmd.emitSetColor(0.565, 0.933, 0.565, 1.0); // #90EE90
    } else if (preview) {
      cmd.emitSetColor(0.0, 0.749, 1.0, 1.0); // #00bfff
    } else {
      cmd.emitSetColor(seg.r, seg.g, seg.b, seg.a);
    }

    cmd.emitSetMatrix(mvp);
    cmd.emitSetLineWidth(selected ? 2.0 : 1.0);

    if (construction) {
      // Subdivide line into dashed segments for construction geometry.
      // WebGL doesn't support line dash natively, so we create geometry.
      const totalLen: f32 = <f32>Math.sqrt(<f64>((seg.x2 - seg.x1) * (seg.x2 - seg.x1) + (seg.y2 - seg.y1) * (seg.y2 - seg.y1)));
      if (totalLen > 0) {
        const ux: f32 = (seg.x2 - seg.x1) / totalLen;
        const uy: f32 = (seg.y2 - seg.y1) / totalLen;
        const period: f32 = DASH_LENGTH + GAP_LENGTH;
        const dashCount: i32 = <i32>(totalLen / period) + 1;
        const dashVerts = new StaticArray<f32>(dashCount * 6);
        let vi: i32 = 0;
        let t: f32 = 0;
        for (let d: i32 = 0; d < dashCount; d++) {
          const t0 = t;
          let t1 = t + DASH_LENGTH;
          if (t1 > totalLen) t1 = totalLen;
          if (t0 < totalLen) {
            unchecked(dashVerts[vi++] = seg.x1 + ux * t0);
            unchecked(dashVerts[vi++] = seg.y1 + uy * t0);
            unchecked(dashVerts[vi++] = 0);
            unchecked(dashVerts[vi++] = seg.x1 + ux * t1);
            unchecked(dashVerts[vi++] = seg.y1 + uy * t1);
            unchecked(dashVerts[vi++] = 0);
          }
          t += period;
          if (t >= totalLen) break;
        }
        if (vi > 0) {
          const trimmed = new StaticArray<f32>(vi);
          for (let k: i32 = 0; k < vi; k++) unchecked(trimmed[k] = dashVerts[k]);
          cmd.emitDrawLines(trimmed, vi / 3);
        }
      }
    } else {
      const verts = new StaticArray<f32>(6);
      unchecked(verts[0] = seg.x1); unchecked(verts[1] = seg.y1); unchecked(verts[2] = 0);
      unchecked(verts[3] = seg.x2); unchecked(verts[4] = seg.y2); unchecked(verts[5] = 0);
      cmd.emitDrawLines(verts, 2);
    }
  }

  // --- Circles ---
  for (let i: i32 = 0; i < entities.circles.length; i++) {
    const circle = unchecked(entities.circles[i]);
    if (!(circle.flags & FLAG_VISIBLE)) continue;

    const selected = (circle.flags & FLAG_SELECTED) != 0;
    const hover = (circle.flags & FLAG_HOVER) != 0;
    const construction = (circle.flags & FLAG_CONSTRUCTION) != 0;

    if (selected) {
      cmd.emitSetColor(0.0, 0.749, 1.0, 1.0);
    } else if (hover) {
      cmd.emitSetColor(0.498, 0.847, 1.0, 1.0);
    } else if (construction) {
      cmd.emitSetColor(0.565, 0.933, 0.565, 1.0);
    } else {
      cmd.emitSetColor(circle.r, circle.g, circle.b, circle.a);
    }

    cmd.emitSetMatrix(mvp);
    cmd.emitSetLineWidth(selected ? 2.0 : 1.0);

    // Tessellate circle as line segments
    // For construction, emit every other segment pair to create a dashed appearance
    const vertCount = CIRCLE_SEGMENTS * 2;
    const verts = new StaticArray<f32>(vertCount * 3);
    for (let s: i32 = 0; s < CIRCLE_SEGMENTS; s++) {
      const a0: f32 = <f32>(<f64>s / <f64>CIRCLE_SEGMENTS * Math.PI * 2.0);
      const a1: f32 = <f32>(<f64>(s + 1) / <f64>CIRCLE_SEGMENTS * Math.PI * 2.0);
      const idx = s * 6;
      unchecked(verts[idx]     = circle.cx + circle.radius * <f32>Math.cos(<f64>a0));
      unchecked(verts[idx + 1] = circle.cy + circle.radius * <f32>Math.sin(<f64>a0));
      unchecked(verts[idx + 2] = 0);
      unchecked(verts[idx + 3] = circle.cx + circle.radius * <f32>Math.cos(<f64>a1));
      unchecked(verts[idx + 4] = circle.cy + circle.radius * <f32>Math.sin(<f64>a1));
      unchecked(verts[idx + 5] = 0);
    }
    if (construction) {
      // Dashed circle: draw DASH_STEP/2 segments, skip DASH_STEP/2 → ~50% duty
      for (let s: i32 = 0; s < CIRCLE_SEGMENTS; s += DASH_STEP) {
        const drawCount: i32 = DASH_STEP / 2;
        const count: i32 = s + drawCount <= CIRCLE_SEGMENTS ? drawCount : CIRCLE_SEGMENTS - s;
        const dashVerts = new StaticArray<f32>(count * 6);
        for (let k: i32 = 0; k < count; k++) {
          const srcIdx = (s + k) * 6;
          const dstIdx = k * 6;
          for (let j: i32 = 0; j < 6; j++) unchecked(dashVerts[dstIdx + j] = verts[srcIdx + j]);
        }
        cmd.emitDrawLines(dashVerts, count * 2);
      }
    } else {
      cmd.emitDrawLines(verts, vertCount);
    }
  }

  // --- Arcs ---
  for (let i: i32 = 0; i < entities.arcs.length; i++) {
    const arc = unchecked(entities.arcs[i]);
    if (!(arc.flags & FLAG_VISIBLE)) continue;

    const selected = (arc.flags & FLAG_SELECTED) != 0;
    const hover = (arc.flags & FLAG_HOVER) != 0;
    const construction = (arc.flags & FLAG_CONSTRUCTION) != 0;

    if (selected) {
      cmd.emitSetColor(0.0, 0.749, 1.0, 1.0);
    } else if (hover) {
      cmd.emitSetColor(0.498, 0.847, 1.0, 1.0);
    } else if (construction) {
      cmd.emitSetColor(0.565, 0.933, 0.565, 1.0);
    } else {
      cmd.emitSetColor(arc.r, arc.g, arc.b, arc.a);
    }

    cmd.emitSetMatrix(mvp);
    cmd.emitSetLineWidth(selected ? 2.0 : 1.0);

    // Compute arc sweep
    let sweep = arc.endAngle - arc.startAngle;
    if (sweep < 0) sweep += <f32>(Math.PI * 2.0);
    const steps: i32 = <i32>(Math.max(16.0, <f64>CIRCLE_SEGMENTS * <f64>Math.abs(<f64>sweep) / (Math.PI * 2.0)));
    const vertCount = steps * 2;
    const verts = new StaticArray<f32>(vertCount * 3);

    for (let s: i32 = 0; s < steps; s++) {
      const t0 = arc.startAngle + sweep * <f32>s / <f32>steps;
      const t1 = arc.startAngle + sweep * <f32>(s + 1) / <f32>steps;
      const idx = s * 6;
      unchecked(verts[idx]     = arc.cx + arc.radius * <f32>Math.cos(<f64>t0));
      unchecked(verts[idx + 1] = arc.cy + arc.radius * <f32>Math.sin(<f64>t0));
      unchecked(verts[idx + 2] = 0);
      unchecked(verts[idx + 3] = arc.cx + arc.radius * <f32>Math.cos(<f64>t1));
      unchecked(verts[idx + 4] = arc.cy + arc.radius * <f32>Math.sin(<f64>t1));
      unchecked(verts[idx + 5] = 0);
    }
    if (construction) {
      // Dashed arc: draw DASH_STEP/2 segments, skip DASH_STEP/2
      for (let s: i32 = 0; s < steps; s += DASH_STEP) {
        const drawCount: i32 = DASH_STEP / 2;
        const count: i32 = s + drawCount <= steps ? drawCount : steps - s;
        const dashVerts = new StaticArray<f32>(count * 6);
        for (let k: i32 = 0; k < count; k++) {
          const srcIdx = (s + k) * 6;
          const dstIdx = k * 6;
          for (let j: i32 = 0; j < 6; j++) unchecked(dashVerts[dstIdx + j] = verts[srcIdx + j]);
        }
        cmd.emitDrawLines(dashVerts, count * 2);
      }
    } else {
      cmd.emitDrawLines(verts, vertCount);
    }
  }

  // --- Points ---
  for (let i: i32 = 0; i < entities.points.length; i++) {
    const pt = unchecked(entities.points[i]);
    if (!(pt.flags & FLAG_VISIBLE)) continue;

    const selected = (pt.flags & FLAG_SELECTED) != 0;
    const hover = (pt.flags & FLAG_HOVER) != 0;
    const fixed = (pt.flags & FLAG_FIXED) != 0;

    if (selected) {
      cmd.emitSetColor(0.0, 0.749, 1.0, 1.0);
    } else if (hover) {
      cmd.emitSetColor(0.498, 0.847, 1.0, 1.0);
    } else if (fixed) {
      cmd.emitSetColor(1.0, 0.4, 0.267, 1.0); // #ff6644
    } else {
      cmd.emitSetColor(pt.r, pt.g, pt.b, pt.a);
    }

    cmd.emitSetMatrix(mvp);

    const verts = new StaticArray<f32>(3);
    unchecked(verts[0] = pt.x); unchecked(verts[1] = pt.y); unchecked(verts[2] = 0);
    cmd.emitDrawPoints(verts, 1, pt.size);
  }

  // --- Dimensions (extension + dimension lines with arrowheads) ---
  for (let i: i32 = 0; i < entities.dimensions.length; i++) {
    const dim = unchecked(entities.dimensions[i]);
    if (!(dim.flags & FLAG_VISIBLE)) continue;

    const selected = (dim.flags & FLAG_SELECTED) != 0;
    const hover = (dim.flags & FLAG_HOVER) != 0;

    if (selected) {
      cmd.emitSetColor(0.0, 0.749, 1.0, 1.0);
    } else if (hover) {
      cmd.emitSetColor(0.498, 0.847, 1.0, 1.0);
    } else {
      cmd.emitSetColor(dim.r, dim.g, dim.b, dim.a);
    }

    cmd.emitSetMatrix(mvp);
    cmd.emitSetLineWidth(1.0);

    if (dim.dimType == DIM_ANGLE) {
      // Angle dimension: arc from angleStart spanning angleSweep
      const arcR: f32 = <f32>Math.abs(<f64>dim.offset);
      const steps: i32 = <i32>Math.max(16.0, 64.0 * <f64>Math.abs(<f64>dim.angleSweep) / (Math.PI * 2.0));
      const arcVerts = new StaticArray<f32>(steps * 2 * 3);
      for (let s: i32 = 0; s < steps; s++) {
        const t0 = dim.angleStart + dim.angleSweep * <f32>s / <f32>steps;
        const t1 = dim.angleStart + dim.angleSweep * <f32>(s + 1) / <f32>steps;
        const idx = s * 6;
        unchecked(arcVerts[idx]     = dim.x1 + arcR * <f32>Math.cos(<f64>t0));
        unchecked(arcVerts[idx + 1] = dim.y1 + arcR * <f32>Math.sin(<f64>t0));
        unchecked(arcVerts[idx + 2] = 0);
        unchecked(arcVerts[idx + 3] = dim.x1 + arcR * <f32>Math.cos(<f64>t1));
        unchecked(arcVerts[idx + 4] = dim.y1 + arcR * <f32>Math.sin(<f64>t1));
        unchecked(arcVerts[idx + 5] = 0);
      }
      cmd.emitDrawLines(arcVerts, steps * 2);
    } else {
      // Linear dimension: extension lines + dimension line
      const dx: f32 = dim.x2 - dim.x1;
      const dy: f32 = dim.y2 - dim.y1;
      const len: f32 = <f32>Math.sqrt(<f64>(dx * dx + dy * dy));
      const safeLen: f32 = len > 1e-9 ? len : 1.0;

      let d1x: f32, d1y: f32, d2x: f32, d2y: f32;
      if (dim.dimType == DIM_HORIZONTAL) {
        const dimY = dim.y1 + dim.offset;
        d1x = dim.x1; d1y = dimY;
        d2x = dim.x2; d2y = dimY;
      } else if (dim.dimType == DIM_VERTICAL) {
        const dimX = dim.x1 + dim.offset;
        d1x = dimX; d1y = dim.y1;
        d2x = dimX; d2y = dim.y2;
      } else {
        const nx: f32 = -dy / safeLen;
        const ny: f32 = dx / safeLen;
        d1x = dim.x1 + nx * dim.offset;
        d1y = dim.y1 + ny * dim.offset;
        d2x = dim.x2 + nx * dim.offset;
        d2y = dim.y2 + ny * dim.offset;
      }

      // Extension lines (from measurement points to dimension line)
      const extVerts = new StaticArray<f32>(12);
      unchecked(extVerts[0]  = dim.x1); unchecked(extVerts[1]  = dim.y1); unchecked(extVerts[2]  = 0);
      unchecked(extVerts[3]  = d1x);    unchecked(extVerts[4]  = d1y);    unchecked(extVerts[5]  = 0);
      unchecked(extVerts[6]  = dim.x2); unchecked(extVerts[7]  = dim.y2); unchecked(extVerts[8]  = 0);
      unchecked(extVerts[9]  = d2x);    unchecked(extVerts[10] = d2y);    unchecked(extVerts[11] = 0);
      cmd.emitDrawLines(extVerts, 4);

      // Dimension line
      const dimLineVerts = new StaticArray<f32>(6);
      unchecked(dimLineVerts[0] = d1x); unchecked(dimLineVerts[1] = d1y); unchecked(dimLineVerts[2] = 0);
      unchecked(dimLineVerts[3] = d2x); unchecked(dimLineVerts[4] = d2y); unchecked(dimLineVerts[5] = 0);
      cmd.emitDrawLines(dimLineVerts, 2);

      // Arrowheads (small triangles at each end)
      const adx: f32 = d2x - d1x;
      const ady: f32 = d2y - d1y;
      const alen: f32 = <f32>Math.sqrt(<f64>(adx * adx + ady * ady));
      if (alen > 1e-6) {
        const ux: f32 = adx / alen;
        const uy: f32 = ady / alen;
        const arrowSize: f32 = <f32>Math.min(<f64>alen * <f64>ARROW_SIZE_RATIO, <f64>MAX_ARROW_SIZE);
        // Arrow at d1 (pointing toward d1 from inside)
        const arrowVerts = new StaticArray<f32>(12);
        unchecked(arrowVerts[0]  = d1x); unchecked(arrowVerts[1]  = d1y); unchecked(arrowVerts[2]  = 0);
        unchecked(arrowVerts[3]  = d1x + ux * arrowSize + uy * arrowSize * ARROW_HALF_WIDTH);
        unchecked(arrowVerts[4]  = d1y + uy * arrowSize - ux * arrowSize * ARROW_HALF_WIDTH);
        unchecked(arrowVerts[5]  = 0);
        // Arrow at d2 (pointing toward d2 from inside)
        unchecked(arrowVerts[6]  = d2x); unchecked(arrowVerts[7]  = d2y); unchecked(arrowVerts[8]  = 0);
        unchecked(arrowVerts[9]  = d2x - ux * arrowSize - uy * arrowSize * ARROW_HALF_WIDTH);
        unchecked(arrowVerts[10] = d2y - uy * arrowSize + ux * arrowSize * ARROW_HALF_WIDTH);
        unchecked(arrowVerts[11] = 0);
        cmd.emitDrawLines(arrowVerts, 4);
        // Mirror arrowheads
        const arrowVerts2 = new StaticArray<f32>(12);
        unchecked(arrowVerts2[0]  = d1x); unchecked(arrowVerts2[1]  = d1y); unchecked(arrowVerts2[2]  = 0);
        unchecked(arrowVerts2[3]  = d1x + ux * arrowSize - uy * arrowSize * ARROW_HALF_WIDTH);
        unchecked(arrowVerts2[4]  = d1y + uy * arrowSize + ux * arrowSize * ARROW_HALF_WIDTH);
        unchecked(arrowVerts2[5]  = 0);
        unchecked(arrowVerts2[6]  = d2x); unchecked(arrowVerts2[7]  = d2y); unchecked(arrowVerts2[8]  = 0);
        unchecked(arrowVerts2[9]  = d2x - ux * arrowSize + uy * arrowSize * ARROW_HALF_WIDTH);
        unchecked(arrowVerts2[10] = d2y - uy * arrowSize - ux * arrowSize * ARROW_HALF_WIDTH);
        unchecked(arrowVerts2[11] = 0);
        cmd.emitDrawLines(arrowVerts2, 4);
      }
    }
  }

  // --- Snap indicator ---
  if (entities.snapVisible) {
    cmd.emitSetColor(0.0, 1.0, 0.6, 1.0); // #00ff99
    cmd.emitSetMatrix(mvp);
    const snapVerts = new StaticArray<f32>(3);
    unchecked(snapVerts[0] = entities.snapX);
    unchecked(snapVerts[1] = entities.snapY);
    unchecked(snapVerts[2] = 0);
    cmd.emitDrawPoints(snapVerts, 1, 10.0);
  }

  // --- Cursor crosshair ---
  if (entities.cursorVisible) {
    cmd.emitSetColor(0.165, 0.165, 0.165, 1.0); // #2a2a2a
    cmd.emitSetLineWidth(1.0);
    cmd.emitSetMatrix(mvp);
    // Draw very long crosshair lines through cursor position
    const chVerts = new StaticArray<f32>(12);
    // Horizontal line
    unchecked(chVerts[0] = entities.cursorX - CROSSHAIR_EXTENT); unchecked(chVerts[1] = entities.cursorY); unchecked(chVerts[2] = 0);
    unchecked(chVerts[3] = entities.cursorX + CROSSHAIR_EXTENT); unchecked(chVerts[4] = entities.cursorY); unchecked(chVerts[5] = 0);
    // Vertical line
    unchecked(chVerts[6] = entities.cursorX); unchecked(chVerts[7] = entities.cursorY - CROSSHAIR_EXTENT); unchecked(chVerts[8] = 0);
    unchecked(chVerts[9] = entities.cursorX); unchecked(chVerts[10] = entities.cursorY + CROSSHAIR_EXTENT); unchecked(chVerts[11] = 0);
    cmd.emitDrawLines(chVerts, 4);
  }

  cmd.emitSetDepthTest(true);
}

/**
 * Render origin planes as semi-transparent quads visible in 3D mode.
 * Draws XY, XZ, and YZ plane boxes centered at the origin with light blue clickable faces.
 * @param planesVisible - bitmask: bit 0 = XY, bit 1 = XZ, bit 2 = YZ
 */
export function renderOriginPlanes(cmd: CommandBuffer, vp: Mat4, planesVisible: i32 = 7, planesHovered: i32 = 0, planesSelected: i32 = 0): void {
  const planeSize: f32 = 5.0;

  // Draw as non-depth-tested overlay to avoid clipping body geometry.
  cmd.emitSetDepthTest(false);

  // XY plane (z=0) — visible when bit 0 is set
  if (planesVisible & 1) {
    const isHovered: bool = (planesHovered & 1) != 0;
    const isSelected: bool = (planesSelected & 1) != 0;
    // Fill: brighter on hover, even brighter on selected
    const fillAlpha: f32 = isSelected ? <f32>0.30 : (isHovered ? <f32>0.22 : <f32>0.12);
    const fillR: f32 = isSelected ? <f32>0.2 : <f32>0.53;
    const fillG: f32 = isSelected ? <f32>0.6 : <f32>0.81;
    const fillB: f32 = isSelected ? <f32>1.0 : <f32>0.92;

    const xyVerts = new StaticArray<f32>(18);
    const xyNorms = new StaticArray<f32>(18);
    unchecked(xyVerts[0]  = -planeSize); unchecked(xyVerts[1]  = -planeSize); unchecked(xyVerts[2]  = 0);
    unchecked(xyVerts[3]  =  planeSize); unchecked(xyVerts[4]  = -planeSize); unchecked(xyVerts[5]  = 0);
    unchecked(xyVerts[6]  =  planeSize); unchecked(xyVerts[7]  =  planeSize); unchecked(xyVerts[8]  = 0);
    unchecked(xyVerts[9]  = -planeSize); unchecked(xyVerts[10] = -planeSize); unchecked(xyVerts[11] = 0);
    unchecked(xyVerts[12] =  planeSize); unchecked(xyVerts[13] =  planeSize); unchecked(xyVerts[14] = 0);
    unchecked(xyVerts[15] = -planeSize); unchecked(xyVerts[16] =  planeSize); unchecked(xyVerts[17] = 0);
    for (let i: i32 = 0; i < 6; i++) {
      unchecked(xyNorms[i * 3]     = 0);
      unchecked(xyNorms[i * 3 + 1] = 0);
      unchecked(xyNorms[i * 3 + 2] = 1);
    }
    cmd.emitSetProgram(0);
    cmd.emitSetMatrix(vp);
    cmd.emitSetColor(fillR, fillG, fillB, fillAlpha);
    cmd.emitDrawTriangles(xyVerts, xyNorms, 6);

    // XY plane border
    const borderAlpha: f32 = isSelected ? <f32>0.9 : (isHovered ? <f32>0.7 : <f32>0.4);
    const borderWidth: f32 = isSelected ? <f32>2.5 : (isHovered ? <f32>2.0 : <f32>1.0);
    const xyBorder = new StaticArray<f32>(24);
    unchecked(xyBorder[0]  = -planeSize); unchecked(xyBorder[1]  = -planeSize); unchecked(xyBorder[2]  = 0);
    unchecked(xyBorder[3]  =  planeSize); unchecked(xyBorder[4]  = -planeSize); unchecked(xyBorder[5]  = 0);
    unchecked(xyBorder[6]  =  planeSize); unchecked(xyBorder[7]  = -planeSize); unchecked(xyBorder[8]  = 0);
    unchecked(xyBorder[9]  =  planeSize); unchecked(xyBorder[10] =  planeSize); unchecked(xyBorder[11] = 0);
    unchecked(xyBorder[12] =  planeSize); unchecked(xyBorder[13] =  planeSize); unchecked(xyBorder[14] = 0);
    unchecked(xyBorder[15] = -planeSize); unchecked(xyBorder[16] =  planeSize); unchecked(xyBorder[17] = 0);
    unchecked(xyBorder[18] = -planeSize); unchecked(xyBorder[19] =  planeSize); unchecked(xyBorder[20] = 0);
    unchecked(xyBorder[21] = -planeSize); unchecked(xyBorder[22] = -planeSize); unchecked(xyBorder[23] = 0);
    cmd.emitSetProgram(1);
    cmd.emitSetMatrix(vp);
    cmd.emitSetColor(fillR, fillG, fillB, borderAlpha);
    cmd.emitSetLineWidth(borderWidth);
    cmd.emitDrawLines(xyBorder, 8);
  }

  // XZ plane (y=0) — visible when bit 1 is set
  if (planesVisible & 2) {
    const isHovered: bool = (planesHovered & 2) != 0;
    const isSelected: bool = (planesSelected & 2) != 0;
    const fillAlpha: f32 = isSelected ? <f32>0.30 : (isHovered ? <f32>0.22 : <f32>0.12);
    const fillR: f32 = isSelected ? <f32>0.2 : <f32>0.53;
    const fillG: f32 = isSelected ? <f32>0.6 : <f32>0.81;
    const fillB: f32 = isSelected ? <f32>1.0 : <f32>0.92;

    const xzVerts = new StaticArray<f32>(18);
    const xzNorms = new StaticArray<f32>(18);
    unchecked(xzVerts[0]  = -planeSize); unchecked(xzVerts[1]  = 0); unchecked(xzVerts[2]  = -planeSize);
    unchecked(xzVerts[3]  =  planeSize); unchecked(xzVerts[4]  = 0); unchecked(xzVerts[5]  = -planeSize);
    unchecked(xzVerts[6]  =  planeSize); unchecked(xzVerts[7]  = 0); unchecked(xzVerts[8]  =  planeSize);
    unchecked(xzVerts[9]  = -planeSize); unchecked(xzVerts[10] = 0); unchecked(xzVerts[11] = -planeSize);
    unchecked(xzVerts[12] =  planeSize); unchecked(xzVerts[13] = 0); unchecked(xzVerts[14] =  planeSize);
    unchecked(xzVerts[15] = -planeSize); unchecked(xzVerts[16] = 0); unchecked(xzVerts[17] =  planeSize);
    for (let i: i32 = 0; i < 6; i++) {
      unchecked(xzNorms[i * 3]     = 0);
      unchecked(xzNorms[i * 3 + 1] = 1);
      unchecked(xzNorms[i * 3 + 2] = 0);
    }
    cmd.emitSetProgram(0);
    cmd.emitSetMatrix(vp);
    cmd.emitSetColor(fillR, fillG, fillB, fillAlpha);
    cmd.emitDrawTriangles(xzVerts, xzNorms, 6);

    // XZ plane border
    const borderAlpha: f32 = isSelected ? <f32>0.9 : (isHovered ? <f32>0.7 : <f32>0.4);
    const borderWidth: f32 = isSelected ? <f32>2.5 : (isHovered ? <f32>2.0 : <f32>1.0);
    const xzBorder = new StaticArray<f32>(24);
    unchecked(xzBorder[0]  = -planeSize); unchecked(xzBorder[1]  = 0); unchecked(xzBorder[2]  = -planeSize);
    unchecked(xzBorder[3]  =  planeSize); unchecked(xzBorder[4]  = 0); unchecked(xzBorder[5]  = -planeSize);
    unchecked(xzBorder[6]  =  planeSize); unchecked(xzBorder[7]  = 0); unchecked(xzBorder[8]  = -planeSize);
    unchecked(xzBorder[9]  =  planeSize); unchecked(xzBorder[10] = 0); unchecked(xzBorder[11] =  planeSize);
    unchecked(xzBorder[12] =  planeSize); unchecked(xzBorder[13] = 0); unchecked(xzBorder[14] =  planeSize);
    unchecked(xzBorder[15] = -planeSize); unchecked(xzBorder[16] = 0); unchecked(xzBorder[17] =  planeSize);
    unchecked(xzBorder[18] = -planeSize); unchecked(xzBorder[19] = 0); unchecked(xzBorder[20] =  planeSize);
    unchecked(xzBorder[21] = -planeSize); unchecked(xzBorder[22] = 0); unchecked(xzBorder[23] = -planeSize);
    cmd.emitSetProgram(1);
    cmd.emitSetMatrix(vp);
    cmd.emitSetColor(fillR, fillG, fillB, borderAlpha);
    cmd.emitSetLineWidth(borderWidth);
    cmd.emitDrawLines(xzBorder, 8);
  }

  // YZ plane (x=0) — visible when bit 2 is set
  if (planesVisible & 4) {
    const isHovered: bool = (planesHovered & 4) != 0;
    const isSelected: bool = (planesSelected & 4) != 0;
    const fillAlpha: f32 = isSelected ? <f32>0.30 : (isHovered ? <f32>0.22 : <f32>0.12);
    const fillR: f32 = isSelected ? <f32>0.2 : <f32>0.53;
    const fillG: f32 = isSelected ? <f32>0.6 : <f32>0.81;
    const fillB: f32 = isSelected ? <f32>1.0 : <f32>0.92;

    const yzVerts = new StaticArray<f32>(18);
    const yzNorms = new StaticArray<f32>(18);
    unchecked(yzVerts[0]  = 0); unchecked(yzVerts[1]  = -planeSize); unchecked(yzVerts[2]  = -planeSize);
    unchecked(yzVerts[3]  = 0); unchecked(yzVerts[4]  =  planeSize); unchecked(yzVerts[5]  = -planeSize);
    unchecked(yzVerts[6]  = 0); unchecked(yzVerts[7]  =  planeSize); unchecked(yzVerts[8]  =  planeSize);
    unchecked(yzVerts[9]  = 0); unchecked(yzVerts[10] = -planeSize); unchecked(yzVerts[11] = -planeSize);
    unchecked(yzVerts[12] = 0); unchecked(yzVerts[13] =  planeSize); unchecked(yzVerts[14] =  planeSize);
    unchecked(yzVerts[15] = 0); unchecked(yzVerts[16] = -planeSize); unchecked(yzVerts[17] =  planeSize);
    for (let i: i32 = 0; i < 6; i++) {
      unchecked(yzNorms[i * 3]     = 1);
      unchecked(yzNorms[i * 3 + 1] = 0);
      unchecked(yzNorms[i * 3 + 2] = 0);
    }
    cmd.emitSetProgram(0);
    cmd.emitSetMatrix(vp);
    cmd.emitSetColor(fillR, fillG, fillB, fillAlpha);
    cmd.emitDrawTriangles(yzVerts, yzNorms, 6);

    // YZ plane border
    const borderAlpha: f32 = isSelected ? <f32>0.9 : (isHovered ? <f32>0.7 : <f32>0.4);
    const borderWidth: f32 = isSelected ? <f32>2.5 : (isHovered ? <f32>2.0 : <f32>1.0);
    const yzBorder = new StaticArray<f32>(24);
    unchecked(yzBorder[0]  = 0); unchecked(yzBorder[1]  = -planeSize); unchecked(yzBorder[2]  = -planeSize);
    unchecked(yzBorder[3]  = 0); unchecked(yzBorder[4]  =  planeSize); unchecked(yzBorder[5]  = -planeSize);
    unchecked(yzBorder[6]  = 0); unchecked(yzBorder[7]  =  planeSize); unchecked(yzBorder[8]  = -planeSize);
    unchecked(yzBorder[9]  = 0); unchecked(yzBorder[10] =  planeSize); unchecked(yzBorder[11] =  planeSize);
    unchecked(yzBorder[12] = 0); unchecked(yzBorder[13] =  planeSize); unchecked(yzBorder[14] =  planeSize);
    unchecked(yzBorder[15] = 0); unchecked(yzBorder[16] = -planeSize); unchecked(yzBorder[17] =  planeSize);
    unchecked(yzBorder[18] = 0); unchecked(yzBorder[19] = -planeSize); unchecked(yzBorder[20] =  planeSize);
    unchecked(yzBorder[21] = 0); unchecked(yzBorder[22] = -planeSize); unchecked(yzBorder[23] = -planeSize);
    cmd.emitSetProgram(1);
    cmd.emitSetMatrix(vp);
    cmd.emitSetColor(fillR, fillG, fillB, borderAlpha);
    cmd.emitSetLineWidth(borderWidth);
    cmd.emitDrawLines(yzBorder, 8);
  }

  cmd.emitSetDepthTest(true);
}

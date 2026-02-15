// assembly/render2d.ts — 2D entity rendering via command buffer
// Renders segments, circles, arcs, and points on the XY plane (z=0).

import { Mat4, Color } from "./math";
import { CommandBuffer } from "./commands";
import { EntityStore, FLAG_VISIBLE, FLAG_SELECTED, FLAG_CONSTRUCTION, FLAG_HOVER, FLAG_FIXED, FLAG_PREVIEW } from "./entities";

const CIRCLE_SEGMENTS: i32 = 64;

/**
 * Render all 2D entities into the command buffer.
 * Entities are drawn on the XY plane at z=0.
 */
export function render2DEntities(cmd: CommandBuffer, vp: Mat4, entities: EntityStore): void {
  cmd.emitSetProgram(1); // line/point shader
  cmd.emitSetDepthTest(false);

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

    cmd.emitSetMatrix(vp);
    cmd.emitSetLineWidth(selected ? 2.0 : 1.0);

    const verts = new StaticArray<f32>(6);
    unchecked(verts[0] = seg.x1); unchecked(verts[1] = seg.y1); unchecked(verts[2] = 0);
    unchecked(verts[3] = seg.x2); unchecked(verts[4] = seg.y2); unchecked(verts[5] = 0);
    cmd.emitDrawLines(verts, 2);
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

    cmd.emitSetMatrix(vp);
    cmd.emitSetLineWidth(selected ? 2.0 : 1.0);

    // Tessellate circle as line segments
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
    cmd.emitDrawLines(verts, vertCount);
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

    cmd.emitSetMatrix(vp);
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
    cmd.emitDrawLines(verts, vertCount);
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

    cmd.emitSetMatrix(vp);

    const verts = new StaticArray<f32>(3);
    unchecked(verts[0] = pt.x); unchecked(verts[1] = pt.y); unchecked(verts[2] = 0);
    cmd.emitDrawPoints(verts, 1, pt.size);
  }

  // --- Snap indicator ---
  if (entities.snapVisible) {
    cmd.emitSetColor(0.0, 1.0, 0.6, 1.0); // #00ff99
    cmd.emitSetMatrix(vp);
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
    cmd.emitSetMatrix(vp);
    // Draw very long crosshair lines through cursor position
    const chVerts = new StaticArray<f32>(12);
    // Horizontal line
    unchecked(chVerts[0] = entities.cursorX - 10000); unchecked(chVerts[1] = entities.cursorY); unchecked(chVerts[2] = 0);
    unchecked(chVerts[3] = entities.cursorX + 10000); unchecked(chVerts[4] = entities.cursorY); unchecked(chVerts[5] = 0);
    // Vertical line
    unchecked(chVerts[6] = entities.cursorX); unchecked(chVerts[7] = entities.cursorY - 10000); unchecked(chVerts[8] = 0);
    unchecked(chVerts[9] = entities.cursorX); unchecked(chVerts[10] = entities.cursorY + 10000); unchecked(chVerts[11] = 0);
    cmd.emitDrawLines(chVerts, 4);
  }

  cmd.emitSetDepthTest(true);
}

/**
 * Render origin planes as semi-transparent quads visible in 3D mode.
 */
export function renderOriginPlanes(cmd: CommandBuffer, vp: Mat4): void {
  const planeSize: f32 = 5.0;

  // XY plane (blue, semi-transparent)
  const xyVerts = new StaticArray<f32>(18);
  const xyNorms = new StaticArray<f32>(18);
  // Triangle 1
  unchecked(xyVerts[0]  = -planeSize); unchecked(xyVerts[1]  = -planeSize); unchecked(xyVerts[2]  = 0);
  unchecked(xyVerts[3]  =  planeSize); unchecked(xyVerts[4]  = -planeSize); unchecked(xyVerts[5]  = 0);
  unchecked(xyVerts[6]  =  planeSize); unchecked(xyVerts[7]  =  planeSize); unchecked(xyVerts[8]  = 0);
  // Triangle 2
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
  cmd.emitSetColor(0.2, 0.2, 0.8, 0.08);
  cmd.emitDrawTriangles(xyVerts, xyNorms, 6);
}

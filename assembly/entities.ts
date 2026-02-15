// assembly/entities.ts — 2D entity storage for WASM-based rendering
// Entities are pushed from JS and rendered via the command buffer.

import { Color } from "./math";

// Maximum entity counts
const MAX_SEGMENTS: i32 = 4096;
const MAX_CIRCLES: i32  = 2048;
const MAX_ARCS: i32     = 2048;
const MAX_POINTS: i32   = 8192;

// Entity flags
export const FLAG_VISIBLE: i32      = 1;
export const FLAG_SELECTED: i32     = 2;
export const FLAG_CONSTRUCTION: i32 = 4;
export const FLAG_HOVER: i32        = 8;
export const FLAG_FIXED: i32        = 16;
export const FLAG_PREVIEW: i32      = 32;

export class Segment {
  x1: f32; y1: f32;
  x2: f32; y2: f32;
  flags: i32;
  r: f32; g: f32; b: f32; a: f32;

  constructor() {
    this.x1 = 0; this.y1 = 0;
    this.x2 = 0; this.y2 = 0;
    this.flags = FLAG_VISIBLE;
    this.r = 0.612; this.g = 0.863; this.b = 0.996; this.a = 1.0; // #9CDCFE
  }
}

export class Circle2D {
  cx: f32; cy: f32;
  radius: f32;
  flags: i32;
  r: f32; g: f32; b: f32; a: f32;

  constructor() {
    this.cx = 0; this.cy = 0;
    this.radius = 1;
    this.flags = FLAG_VISIBLE;
    this.r = 0.612; this.g = 0.863; this.b = 0.996; this.a = 1.0;
  }
}

export class Arc2D {
  cx: f32; cy: f32;
  radius: f32;
  startAngle: f32;
  endAngle: f32;
  flags: i32;
  r: f32; g: f32; b: f32; a: f32;

  constructor() {
    this.cx = 0; this.cy = 0;
    this.radius = 1;
    this.startAngle = 0;
    this.endAngle = <f32>Math.PI;
    this.flags = FLAG_VISIBLE;
    this.r = 0.612; this.g = 0.863; this.b = 0.996; this.a = 1.0;
  }
}

export class Point2D {
  x: f32; y: f32;
  flags: i32;
  size: f32;
  r: f32; g: f32; b: f32; a: f32;

  constructor() {
    this.x = 0; this.y = 0;
    this.flags = FLAG_VISIBLE;
    this.size = 4.0;
    this.r = 1.0; this.g = 1.0; this.b = 0.4; this.a = 1.0; // #ffff66
  }
}

/**
 * EntityStore — flat arrays of 2D entities managed from JS side.
 * JS pushes entity data, WASM renders them each frame.
 */
export class EntityStore {
  segments: Array<Segment>;
  circles: Array<Circle2D>;
  arcs: Array<Arc2D>;
  points: Array<Point2D>;

  // Snap point
  snapX: f32;
  snapY: f32;
  snapVisible: bool;

  // Cursor crosshair
  cursorX: f32;
  cursorY: f32;
  cursorVisible: bool;

  constructor() {
    this.segments = new Array<Segment>();
    this.circles = new Array<Circle2D>();
    this.arcs = new Array<Arc2D>();
    this.points = new Array<Point2D>();
    this.snapX = 0;
    this.snapY = 0;
    this.snapVisible = false;
    this.cursorX = 0;
    this.cursorY = 0;
    this.cursorVisible = false;
  }

  clear(): void {
    this.segments = new Array<Segment>();
    this.circles = new Array<Circle2D>();
    this.arcs = new Array<Arc2D>();
    this.points = new Array<Point2D>();
    this.snapVisible = false;
    this.cursorVisible = false;
  }

  addSegment(x1: f32, y1: f32, x2: f32, y2: f32,
             flags: i32, r: f32, g: f32, b: f32, a: f32): i32 {
    const seg = new Segment();
    seg.x1 = x1; seg.y1 = y1;
    seg.x2 = x2; seg.y2 = y2;
    seg.flags = flags;
    seg.r = r; seg.g = g; seg.b = b; seg.a = a;
    this.segments.push(seg);
    return this.segments.length - 1;
  }

  addCircle(cx: f32, cy: f32, radius: f32,
            flags: i32, r: f32, g: f32, b: f32, a: f32): i32 {
    const c = new Circle2D();
    c.cx = cx; c.cy = cy; c.radius = radius;
    c.flags = flags;
    c.r = r; c.g = g; c.b = b; c.a = a;
    this.circles.push(c);
    return this.circles.length - 1;
  }

  addArc(cx: f32, cy: f32, radius: f32,
         startAngle: f32, endAngle: f32,
         flags: i32, r: f32, g: f32, b: f32, a: f32): i32 {
    const arc = new Arc2D();
    arc.cx = cx; arc.cy = cy; arc.radius = radius;
    arc.startAngle = startAngle; arc.endAngle = endAngle;
    arc.flags = flags;
    arc.r = r; arc.g = g; arc.b = b; arc.a = a;
    this.arcs.push(arc);
    return this.arcs.length - 1;
  }

  addPoint(x: f32, y: f32, size: f32,
           flags: i32, r: f32, g: f32, b: f32, a: f32): i32 {
    const p = new Point2D();
    p.x = x; p.y = y; p.size = size;
    p.flags = flags;
    p.r = r; p.g = g; p.b = b; p.a = a;
    this.points.push(p);
    return this.points.length - 1;
  }
}

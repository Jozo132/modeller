import { Mat4, Color } from "./math";

// Command type IDs
export const CMD_END: i32             = 0;
export const CMD_CLEAR: i32           = 1;
export const CMD_SET_PROGRAM: i32     = 2;
export const CMD_SET_MATRIX: i32      = 3;
export const CMD_SET_COLOR: i32       = 4;
export const CMD_DRAW_TRIANGLES: i32  = 5;
export const CMD_DRAW_LINES: i32      = 6;
export const CMD_DRAW_POINTS: i32     = 7;
export const CMD_SET_LINE_DASH: i32   = 8;
export const CMD_SET_DEPTH_TEST: i32  = 9;
export const CMD_SET_LINE_WIDTH: i32  = 10;

// 4MB buffer = 1048576 f32 values
const BUFFER_SIZE: i32 = 1048576;

export class CommandBuffer {
  buffer: StaticArray<f32>;
  cursor: i32;

  constructor() {
    this.buffer = new StaticArray<f32>(BUFFER_SIZE);
    this.cursor = 0;
  }

  reset(): void {
    this.cursor = 0;
  }

  @inline
  private writeF32(v: f32): void {
    if (this.cursor < BUFFER_SIZE) {
      unchecked(this.buffer[this.cursor] = v);
      this.cursor++;
    }
  }

  @inline
  private writeI32AsF32(v: i32): void {
    this.writeF32(reinterpret<f32>(v));
  }

  // CMD_CLEAR: cmdId, r, g, b, a
  emitClear(r: f32, g: f32, b: f32, a: f32): void {
    this.writeI32AsF32(CMD_CLEAR);
    this.writeF32(r);
    this.writeF32(g);
    this.writeF32(b);
    this.writeF32(a);
  }

  // CMD_SET_PROGRAM: cmdId, programIndex
  emitSetProgram(program: i32): void {
    this.writeI32AsF32(CMD_SET_PROGRAM);
    this.writeI32AsF32(program);
  }

  // CMD_SET_MATRIX: cmdId, 16 floats
  emitSetMatrix(mat: Mat4): void {
    this.writeI32AsF32(CMD_SET_MATRIX);
    const d = mat.data;
    for (let i: i32 = 0; i < 16; i++) {
      this.writeF32(unchecked(d[i]));
    }
  }

  // CMD_SET_COLOR: cmdId, r, g, b, a
  emitSetColor(r: f32, g: f32, b: f32, a: f32): void {
    this.writeI32AsF32(CMD_SET_COLOR);
    this.writeF32(r);
    this.writeF32(g);
    this.writeF32(b);
    this.writeF32(a);
  }

  emitSetColorObj(c: Color): void {
    this.emitSetColor(c.r, c.g, c.b, c.a);
  }

  // CMD_DRAW_TRIANGLES: cmdId, vertexCount, then vertexCount * 6 floats (x,y,z, nx,ny,nz)
  emitDrawTriangles(vertices: StaticArray<f32>, normals: StaticArray<f32>, count: i32): void {
    this.writeI32AsF32(CMD_DRAW_TRIANGLES);
    this.writeI32AsF32(count);
    for (let i: i32 = 0; i < count; i++) {
      const idx = i * 3;
      this.writeF32(unchecked(vertices[idx]));
      this.writeF32(unchecked(vertices[idx + 1]));
      this.writeF32(unchecked(vertices[idx + 2]));
      this.writeF32(unchecked(normals[idx]));
      this.writeF32(unchecked(normals[idx + 1]));
      this.writeF32(unchecked(normals[idx + 2]));
    }
  }

  // CMD_DRAW_LINES: cmdId, vertexCount, then vertexCount * 3 floats (x,y,z)
  emitDrawLines(vertices: StaticArray<f32>, count: i32): void {
    this.writeI32AsF32(CMD_DRAW_LINES);
    this.writeI32AsF32(count);
    for (let i: i32 = 0; i < count; i++) {
      const idx = i * 3;
      this.writeF32(unchecked(vertices[idx]));
      this.writeF32(unchecked(vertices[idx + 1]));
      this.writeF32(unchecked(vertices[idx + 2]));
    }
  }

  // CMD_DRAW_POINTS: cmdId, vertexCount, pointSize, then vertexCount * 3 floats
  emitDrawPoints(vertices: StaticArray<f32>, count: i32, pointSize: f32): void {
    this.writeI32AsF32(CMD_DRAW_POINTS);
    this.writeI32AsF32(count);
    this.writeF32(pointSize);
    for (let i: i32 = 0; i < count; i++) {
      const idx = i * 3;
      this.writeF32(unchecked(vertices[idx]));
      this.writeF32(unchecked(vertices[idx + 1]));
      this.writeF32(unchecked(vertices[idx + 2]));
    }
  }

  // CMD_SET_LINE_DASH: cmdId, dashSize, gapSize
  emitSetLineDash(dashSize: f32, gapSize: f32): void {
    this.writeI32AsF32(CMD_SET_LINE_DASH);
    this.writeF32(dashSize);
    this.writeF32(gapSize);
  }

  // CMD_SET_DEPTH_TEST: cmdId, enabled (1 or 0)
  emitSetDepthTest(enabled: bool): void {
    this.writeI32AsF32(CMD_SET_DEPTH_TEST);
    this.writeI32AsF32(enabled ? 1 : 0);
  }

  // CMD_SET_LINE_WIDTH: cmdId, width
  emitSetLineWidth(width: f32): void {
    this.writeI32AsF32(CMD_SET_LINE_WIDTH);
    this.writeF32(width);
  }

  // CMD_END
  emitEnd(): void {
    this.writeI32AsF32(CMD_END);
  }

  getBufferPtr(): usize {
    return changetype<usize>(this.buffer);
  }

  getBufferLength(): i32 {
    return this.cursor;
  }
}

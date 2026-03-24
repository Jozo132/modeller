import { mat4TransformVec4, projectClipToScreen } from './render-math.js';

const CMD_END = 0;
const CMD_CLEAR = 1;
const CMD_SET_PROGRAM = 2;
const CMD_SET_MATRIX = 3;
const CMD_SET_COLOR = 4;
const CMD_DRAW_TRIANGLES = 5;
const CMD_DRAW_LINES = 6;
const CMD_DRAW_POINTS = 7;
const CMD_SET_LINE_DASH = 8;
const CMD_SET_DEPTH_TEST = 9;
const CMD_SET_LINE_WIDTH = 10;
const CMD_SET_DEPTH_WRITE = 11;

const LIGHT_DIR = normalize({ x: 0.3, y: 0.5, z: 0.8 });

function normalize(v) {
  const len = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function colorToCss(color, shade = 1) {
  const r = Math.round(clamp01(color[0] * shade) * 255);
  const g = Math.round(clamp01(color[1] * shade) * 255);
  const b = Math.round(clamp01(color[2] * shade) * 255);
  const a = clamp01(color[3]);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export class CanvasCommandExecutor {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = canvas.width;
    this.height = canvas.height;
    this.currentMatrix = new Float32Array([
      1, 0, 0, 0,
      0, 1, 0, 0,
      0, 0, 1, 0,
      0, 0, 0, 1,
    ]);
    this.currentColor = [1, 1, 1, 1];
    this.lineDash = [];
    this.lineWidth = 1;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  setViewDir(_x, _y, _z) {
    // No-op for canvas executor (lighting not used in 2D canvas rendering)
  }

  clear(color = [0.93, 0.95, 0.97, 1]) {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = colorToCss(color);
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.restore();
  }

  execute(commandBuffer, length) {
    const i32View = new Int32Array(commandBuffer.buffer, commandBuffer.byteOffset, length);
    let pos = 0;
    while (pos < length) {
      const cmd = i32View[pos++];
      switch (cmd) {
        case CMD_END:
          return;
        case CMD_CLEAR:
          this.clear(commandBuffer.subarray(pos, pos + 4));
          pos += 4;
          break;
        case CMD_SET_PROGRAM:
          pos += 1;
          break;
        case CMD_SET_MATRIX:
          this.currentMatrix = commandBuffer.slice(pos, pos + 16);
          pos += 16;
          break;
        case CMD_SET_COLOR:
          this.currentColor = Array.from(commandBuffer.subarray(pos, pos + 4));
          pos += 4;
          break;
        case CMD_DRAW_TRIANGLES: {
          const vertexCount = i32View[pos++];
          const floatCount = vertexCount * 6;
          const data = commandBuffer.subarray(pos, pos + floatCount);
          pos += floatCount;
          this.drawTriangleBuffer(data, vertexCount, { mvp: this.currentMatrix, color: this.currentColor });
          break;
        }
        case CMD_DRAW_LINES: {
          const vertexCount = i32View[pos++];
          const floatCount = vertexCount * 3;
          const data = commandBuffer.subarray(pos, pos + floatCount);
          pos += floatCount;
          this.drawLineBuffer(data, vertexCount, {
            mvp: this.currentMatrix,
            color: this.currentColor,
            lineWidth: this.lineWidth,
            lineDash: this.lineDash,
          });
          break;
        }
        case CMD_DRAW_POINTS: {
          const vertexCount = i32View[pos++];
          const pointSize = commandBuffer[pos++];
          const floatCount = vertexCount * 3;
          const data = commandBuffer.subarray(pos, pos + floatCount);
          pos += floatCount;
          this.drawPointBuffer(data, vertexCount, { mvp: this.currentMatrix, color: this.currentColor, pointSize });
          break;
        }
        case CMD_SET_LINE_DASH:
          this.lineDash = [commandBuffer[pos], commandBuffer[pos + 1]].filter((value) => value > 0);
          pos += 2;
          break;
        case CMD_SET_DEPTH_TEST:
          pos += 1;
          break;
        case CMD_SET_LINE_WIDTH:
          this.lineWidth = commandBuffer[pos++];
          break;
        case CMD_SET_DEPTH_WRITE:
          pos += 1;
          break;
        default:
          return;
      }
    }
  }

  drawTriangleBuffer(data, vertexCount, options) {
    const hatch = !!options.diagnosticHatch;
    const spacing = 6;
    const hatchAngle = Math.PI / 4;
    const hatchStroke = 'rgba(200,40,40,0.55)';
    const hatchFill = 'rgba(200,40,40,0.18)';

    const triangles = [];
    for (let index = 0; index < vertexCount; index += 3) {
      const projected = [];
      let visible = true;
      let normal = { x: 0, y: 0, z: 1 };
      for (let vertex = 0; vertex < 3; vertex++) {
        const offset = (index + vertex) * 6;
        const clip = mat4TransformVec4(options.mvp, data[offset], data[offset + 1], data[offset + 2], 1);
        const point = projectClipToScreen(clip, this.width, this.height);
        if (!point) {
          visible = false;
          break;
        }
        projected.push(point);
        normal.x += data[offset + 3];
        normal.y += data[offset + 4];
        normal.z += data[offset + 5];
      }
      if (!visible) continue;

      let backFace = false;
      if (hatch) {
        const ax = projected[1].x - projected[0].x;
        const ay = projected[1].y - projected[0].y;
        const bx = projected[2].x - projected[0].x;
        const by = projected[2].y - projected[0].y;
        // In screen space (Y-down), front-facing (CCW in clip) has cross < 0
        backFace = (ax * by - ay * bx) > 0;
      }

      normal = normalize(normal);
      const shade = 0.3 + Math.max(0, normal.x * LIGHT_DIR.x + normal.y * LIGHT_DIR.y + normal.z * LIGHT_DIR.z) * 0.7;
      triangles.push({
        points: projected,
        shade,
        depth: (projected[0].z + projected[1].z + projected[2].z) / 3,
        backFace,
      });
    }

    triangles.sort((a, b) => b.depth - a.depth);

    const ctx = this.ctx;
    ctx.save();
    const cos = Math.cos(hatchAngle);
    const sin = Math.sin(hatchAngle);

    for (const tri of triangles) {
      ctx.beginPath();
      ctx.moveTo(tri.points[0].x, tri.points[0].y);
      ctx.lineTo(tri.points[1].x, tri.points[1].y);
      ctx.lineTo(tri.points[2].x, tri.points[2].y);
      ctx.closePath();

      if (tri.backFace) {
        ctx.fillStyle = hatchFill;
        ctx.fill();
        ctx.save();
        ctx.clip();
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const p of tri.points) {
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        const diag = Math.hypot(maxX - minX, maxY - minY);
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const count = Math.ceil(diag / spacing) + 2;
        ctx.strokeStyle = hatchStroke;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let j = -count; j <= count; j++) {
          const off = j * spacing;
          const x0 = cx + off * cos - diag * sin;
          const y0 = cy + off * sin + diag * cos;
          const x1 = cx + off * cos + diag * sin;
          const y1 = cy + off * sin - diag * cos;
          ctx.moveTo(x0, y0);
          ctx.lineTo(x1, y1);
        }
        ctx.stroke();
        ctx.restore();
      } else {
        ctx.fillStyle = colorToCss(options.color, tri.shade);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  drawLineBuffer(data, vertexCount, options) {
    const ctx = this.ctx;
    ctx.save();
    ctx.strokeStyle = colorToCss(options.color);
    ctx.lineWidth = options.lineWidth || 1;
    ctx.setLineDash(options.lineDash || []);
    ctx.beginPath();
    for (let index = 0; index < vertexCount; index += 2) {
      const a = this._project(data, index * 3, options.mvp);
      const b = this._project(data, (index + 1) * 3, options.mvp);
      if (!a || !b) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.restore();
  }

  drawPointBuffer(data, vertexCount, options) {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = colorToCss(options.color);
    const radius = Math.max(1, (options.pointSize || 1) * 0.5);
    for (let index = 0; index < vertexCount; index++) {
      const point = this._project(data, index * 3, options.mvp);
      if (!point) continue;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  _project(data, offset, mvp) {
    return projectClipToScreen(
      mat4TransformVec4(mvp, data[offset], data[offset + 1], data[offset + 2], 1),
      this.width,
      this.height
    );
  }
}
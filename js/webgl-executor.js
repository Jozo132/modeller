// WebGL command executor - processes batched commands from the WASM module

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

// Program 0: solid/triangle shader with lighting
const SOLID_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
uniform mat4 uMVP;
out vec3 vNormal;
void main() {
  vNormal = aNormal;
  gl_Position = uMVP * vec4(aPosition, 1.0);
}`;

const SOLID_FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
in vec3 vNormal;
out vec4 fragColor;
void main() {
  vec3 lightDir = normalize(vec3(0.3, 0.5, 0.8));
  float ambient = 0.3;
  float diffuse = max(dot(normalize(vNormal), lightDir), 0.0) * 0.7;
  fragColor = vec4(uColor.rgb * (ambient + diffuse), uColor.a);
}`;

// Program 1: line/point shader, no lighting
const LINE_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
uniform mat4 uMVP;
uniform float uPointSize;
void main() {
  gl_Position = uMVP * vec4(aPosition, 1.0);
  gl_PointSize = uPointSize;
}`;

const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 uColor;
out vec4 fragColor;
void main() {
  fragColor = uColor;
}`;

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const info = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error('Shader compile error: ' + info);
  }
  return shader;
}

function createProgram(gl, vsSource, fsSource) {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const info = gl.getProgramInfoLog(program);
    gl.deleteProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error('Program link error: ' + info);
  }
  // Shaders can be detached after linking
  gl.detachShader(program, vs);
  gl.detachShader(program, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return program;
}

export class WebGLExecutor {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', { antialias: true, alpha: false });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;
    this.width = canvas.width;
    this.height = canvas.height;

    // Create shader programs
    this.programs = [
      createProgram(gl, SOLID_VS, SOLID_FS),
      createProgram(gl, LINE_VS, LINE_FS),
    ];

    // Cache uniform locations for each program
    this.uniforms = this.programs.map(p => ({
      uMVP: gl.getUniformLocation(p, 'uMVP'),
      uColor: gl.getUniformLocation(p, 'uColor'),
      uPointSize: gl.getUniformLocation(p, 'uPointSize'),
    }));

    // Dynamic VBO shared across draw calls
    this.vbo = gl.createBuffer();

    // VAO for program 0 (position + normal, stride 24)
    this.vaoSolid = gl.createVertexArray();
    gl.bindVertexArray(this.vaoSolid);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);

    // VAO for program 1 (position only, stride 12)
    this.vaoLine = gl.createVertexArray();
    gl.bindVertexArray(this.vaoLine);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.bindVertexArray(null);

    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    // Default state
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.currentProgram = -1;
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  execute(commandBuffer, length) {
    const gl = this.gl;
    const i32View = new Int32Array(commandBuffer.buffer, commandBuffer.byteOffset, length);

    gl.viewport(0, 0, this.width, this.height);

    let pos = 0;
    while (pos < length) {
      const cmd = i32View[pos];
      pos++;

      switch (cmd) {
        case CMD_END:
          return;

        case CMD_CLEAR: {
          const r = commandBuffer[pos];
          const g = commandBuffer[pos + 1];
          const b = commandBuffer[pos + 2];
          const a = commandBuffer[pos + 3];
          pos += 4;
          gl.clearColor(r, g, b, a);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
          break;
        }

        case CMD_SET_PROGRAM: {
          const idx = i32View[pos];
          pos++;
          this.currentProgram = idx;
          gl.useProgram(this.programs[idx]);
          break;
        }

        case CMD_SET_MATRIX: {
          const mat = commandBuffer.subarray(pos, pos + 16);
          pos += 16;
          if (this.currentProgram >= 0) {
            gl.uniformMatrix4fv(this.uniforms[this.currentProgram].uMVP, false, mat);
          }
          break;
        }

        case CMD_SET_COLOR: {
          const r = commandBuffer[pos];
          const g = commandBuffer[pos + 1];
          const b = commandBuffer[pos + 2];
          const a = commandBuffer[pos + 3];
          pos += 4;
          if (this.currentProgram >= 0) {
            gl.uniform4f(this.uniforms[this.currentProgram].uColor, r, g, b, a);
          }
          break;
        }

        case CMD_DRAW_TRIANGLES: {
          const vertexCount = i32View[pos];
          pos++;
          const floatCount = vertexCount * 6;
          const data = commandBuffer.subarray(pos, pos + floatCount);
          pos += floatCount;

          gl.bindVertexArray(this.vaoSolid);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
          gl.bindVertexArray(null);
          break;
        }

        case CMD_DRAW_LINES: {
          const vertexCount = i32View[pos];
          pos++;
          const floatCount = vertexCount * 3;
          const data = commandBuffer.subarray(pos, pos + floatCount);
          pos += floatCount;

          gl.bindVertexArray(this.vaoLine);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.LINES, 0, vertexCount);
          gl.bindVertexArray(null);
          break;
        }

        case CMD_DRAW_POINTS: {
          const vertexCount = i32View[pos];
          pos++;
          const ptSize = commandBuffer[pos];
          pos++;
          const floatCount = vertexCount * 3;
          const data = commandBuffer.subarray(pos, pos + floatCount);
          pos += floatCount;

          if (this.currentProgram >= 0) {
            gl.uniform1f(this.uniforms[this.currentProgram].uPointSize, ptSize);
          }
          gl.bindVertexArray(this.vaoLine);
          gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
          gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.POINTS, 0, vertexCount);
          gl.bindVertexArray(null);
          break;
        }

        case CMD_SET_LINE_DASH: {
          // Line dash is not natively supported in WebGL; skip the parameters.
          pos += 2;
          break;
        }

        case CMD_SET_DEPTH_TEST: {
          const enabled = i32View[pos];
          pos++;
          if (enabled) {
            gl.enable(gl.DEPTH_TEST);
          } else {
            gl.disable(gl.DEPTH_TEST);
          }
          break;
        }

        case CMD_SET_LINE_WIDTH: {
          const w = commandBuffer[pos];
          pos++;
          gl.lineWidth(w);
          break;
        }

        default:
          // Unknown command; stop processing to avoid corrupt reads
          console.warn('WebGLExecutor: unknown command', cmd, 'at offset', pos - 1);
          return;
      }
    }
  }

  dispose() {
    const gl = this.gl;
    gl.deleteVertexArray(this.vaoSolid);
    gl.deleteVertexArray(this.vaoLine);
    gl.deleteBuffer(this.vbo);
    for (const p of this.programs) {
      gl.deleteProgram(p);
    }
    this.programs = [];
    this.uniforms = [];
    this.currentProgram = -1;
  }
}

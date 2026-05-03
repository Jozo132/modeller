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
const CMD_SET_DEPTH_WRITE = 11;

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
uniform vec3 uViewDir;
in vec3 vNormal;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(0.3, 0.5, 0.8));
  float ambient = 0.3;
  float diffuse = max(dot(n, lightDir), 0.0) * 0.7;
  float camLight = max(dot(n, uViewDir), 0.0) * 0.2;
  fragColor = vec4(uColor.rgb * (ambient + diffuse + camLight), uColor.a);
}`;

// Program 2: diagnostic solid shader with purple/yellow hatch overlay
const DIAG_SOLID_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
uniform mat4 uMVP;
out vec3 vNormal;
void main() {
  vec3 n = normalize(aNormal);
  vNormal = n;
  gl_Position = uMVP * vec4(aPosition + n * 0.01, 1.0);
}`;

const DIAG_SOLID_FS = `#version 300 es
precision mediump float;
uniform vec3 uViewDir;
in vec3 vNormal;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 lightDir = normalize(vec3(0.3, 0.5, 0.8));
  float ambient = 0.35;
  float diffuse = abs(dot(n, lightDir)) * 0.65;
  float camLight = max(dot(n, uViewDir), 0.0) * 0.2;
  float shade = ambient + diffuse + camLight;

  vec3 purple = vec3(0.38, 0.10, 0.52);
  vec3 yellow = vec3(0.97, 0.90, 0.16);
  float stripe = step(fract((gl_FragCoord.x - gl_FragCoord.y) * 0.125), 0.13);
  vec3 color = mix(purple, yellow, stripe);
  fragColor = vec4(color * shade, 0.98);
}`;

// Program 3: normal-color debug shader — maps abs(normal) XYZ to soft RGB
const NORMAL_COLOR_VS = `#version 300 es
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
uniform mat4 uMVP;
out vec3 vNormal;
void main() {
  vNormal = aNormal;
  gl_Position = uMVP * vec4(aPosition, 1.0);
}`;

const NORMAL_COLOR_FS = `#version 300 es
precision mediump float;
uniform vec3 uViewDir;
in vec3 vNormal;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vNormal);
  vec3 absN = abs(n);
  // Soft pastel mapping: blend toward grey to keep colors muted
  vec3 base = absN * 0.45 + 0.35;
  // Light directional shading to preserve depth cues
  vec3 lightDir = normalize(vec3(0.3, 0.5, 0.8));
  float ambient = 0.55;
  float diffuse = max(dot(n, lightDir), 0.0) * 0.35;
  float camLight = max(dot(n, uViewDir), 0.0) * 0.1;
  fragColor = vec4(base * (ambient + diffuse + camLight), 1.0);
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
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      preserveDrawingBuffer: true,
      stencil: true,
    });
    if (!gl) throw new Error('WebGL2 not supported');
    this.gl = gl;
    this.width = canvas.width;
    this.height = canvas.height;

    // Create shader programs
    this.programs = [
      createProgram(gl, SOLID_VS, SOLID_FS),
      createProgram(gl, LINE_VS, LINE_FS),
      createProgram(gl, DIAG_SOLID_VS, DIAG_SOLID_FS),
      createProgram(gl, NORMAL_COLOR_VS, NORMAL_COLOR_FS),
    ];

    // Cache uniform locations for each program
    this.uniforms = this.programs.map(p => ({
      uMVP: gl.getUniformLocation(p, 'uMVP'),
      uColor: gl.getUniformLocation(p, 'uColor'),
      uPointSize: gl.getUniformLocation(p, 'uPointSize'),
      uViewDir: gl.getUniformLocation(p, 'uViewDir'),
    }));

    // Default view direction (will be updated each frame)
    this._viewDir = [0, 0, 1];

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

    // Software GL state shadow — avoids expensive getParameter/isEnabled GPU stalls
    this._st = {
      blend: false,
      depthTest: false,
      depthWrite: true,
      depthFunc: gl.LESS,
      cullFace: false,
      polygonOffset: false,
    };

    // Default state
    gl.enable(gl.DEPTH_TEST);
    this._st.depthTest = true;
    gl.enable(gl.BLEND);
    this._st.blend = true;
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.currentProgram = -1;
  }

  // --- State management (updates shadow + GL, skips redundant calls) ---
  setBlend(on) {
    if (this._st.blend !== on) {
      this._st.blend = on;
      if (on) this.gl.enable(this.gl.BLEND);
      else this.gl.disable(this.gl.BLEND);
    }
  }
  setDepthTest(on) {
    if (this._st.depthTest !== on) {
      this._st.depthTest = on;
      if (on) this.gl.enable(this.gl.DEPTH_TEST);
      else this.gl.disable(this.gl.DEPTH_TEST);
    }
  }
  setDepthWrite(on) {
    if (this._st.depthWrite !== on) {
      this._st.depthWrite = on;
      this.gl.depthMask(on);
    }
  }
  setDepthFunc(fn) {
    if (this._st.depthFunc !== fn) {
      this._st.depthFunc = fn;
      this.gl.depthFunc(fn);
    }
  }
  setCullFace(on) {
    if (this._st.cullFace !== on) {
      this._st.cullFace = on;
      if (on) this.gl.enable(this.gl.CULL_FACE);
      else this.gl.disable(this.gl.CULL_FACE);
    }
  }
  setPolygonOffset(on) {
    if (this._st.polygonOffset !== on) {
      this._st.polygonOffset = on;
      if (on) this.gl.enable(this.gl.POLYGON_OFFSET_FILL);
      else this.gl.disable(this.gl.POLYGON_OFFSET_FILL);
    }
  }

  resize(width, height) {
    this.width = width;
    this.height = height;
  }

  setViewDir(x, y, z) {
    this._viewDir[0] = x;
    this._viewDir[1] = y;
    this._viewDir[2] = z;
  }

  drawTriangleBuffer(data, vertexCount, options) {
    const gl = this.gl;
    const prevBlend = this._st.blend;
    const prevCull = this._st.cullFace;
    const prevPolyOff = this._st.polygonOffset;

    gl.viewport(0, 0, this.width, this.height);
    if ((options.color?.[3] ?? 1) < 1) {
      this.setBlend(true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
    this.setCullFace(true);
    gl.cullFace(gl.BACK);

    if (options.polygonOffset) {
      this.setPolygonOffset(true);
      gl.polygonOffset(options.polygonOffset[0], options.polygonOffset[1]);
    }

    gl.useProgram(this.programs[0]);
    gl.uniformMatrix4fv(this.uniforms[0].uMVP, false, options.mvp);
    gl.uniform4f(this.uniforms[0].uColor, ...(options.color || [1, 1, 1, 1]));
    if (this.uniforms[0].uViewDir) {
      gl.uniform3fv(this.uniforms[0].uViewDir, this._viewDir);
    }

    gl.bindVertexArray(this.vaoSolid);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    gl.bindVertexArray(null);

    this.setPolygonOffset(prevPolyOff);
    this.setCullFace(prevCull);
    this.setBlend(prevBlend);
  }

  drawTriangleBufferNormalColor(data, vertexCount, options) {
    const gl = this.gl;
    const prevBlend = this._st.blend;
    const prevCull = this._st.cullFace;
    const prevPolyOff = this._st.polygonOffset;

    gl.viewport(0, 0, this.width, this.height);
    this.setBlend(false);
    this.setCullFace(true);
    gl.cullFace(gl.BACK);

    if (options.polygonOffset) {
      this.setPolygonOffset(true);
      gl.polygonOffset(options.polygonOffset[0], options.polygonOffset[1]);
    }

    gl.useProgram(this.programs[3]);
    gl.uniformMatrix4fv(this.uniforms[3].uMVP, false, options.mvp);
    if (this.uniforms[3].uViewDir) {
      gl.uniform3fv(this.uniforms[3].uViewDir, this._viewDir);
    }

    gl.bindVertexArray(this.vaoSolid);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, vertexCount);
    gl.bindVertexArray(null);

    this.setPolygonOffset(prevPolyOff);
    this.setCullFace(prevCull);
    this.setBlend(prevBlend);
  }

  drawLineBuffer(data, vertexCount, options) {
    const gl = this.gl;
    const prevBlend = this._st.blend;
    const prevDepthTest = this._st.depthTest;
    const prevDepthWrite = this._st.depthWrite;
    const prevDepthFunc = this._st.depthFunc;

    gl.viewport(0, 0, this.width, this.height);
    if ((options.color?.[3] ?? 1) < 1) {
      this.setBlend(true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    this.setDepthTest(options.depthTest !== false);

    if (options.depthFunc === 'greater') {
      this.setDepthFunc(gl.GREATER);
    } else if (options.depthFunc === 'less') {
      this.setDepthFunc(gl.LESS);
    } else if (options.depthFunc === 'always') {
      this.setDepthFunc(gl.ALWAYS);
    } else {
      this.setDepthFunc(gl.LEQUAL);
    }

    if (Object.prototype.hasOwnProperty.call(options, 'depthWrite')) {
      this.setDepthWrite(!!options.depthWrite);
    }

    gl.useProgram(this.programs[1]);
    gl.uniformMatrix4fv(this.uniforms[1].uMVP, false, options.mvp);
    gl.uniform4f(this.uniforms[1].uColor, ...(options.color || [1, 1, 1, 1]));
    gl.lineWidth(options.lineWidth || 1);

    gl.bindVertexArray(this.vaoLine);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.LINES, 0, vertexCount);
    gl.bindVertexArray(null);

    this.setBlend(prevBlend);
    this.setDepthTest(prevDepthTest);
    this.setDepthWrite(prevDepthWrite);
    this.setDepthFunc(prevDepthFunc);
  }

  drawPointBuffer(data, vertexCount, options) {
    const gl = this.gl;
    const prevBlend = this._st.blend;

    gl.viewport(0, 0, this.width, this.height);
    if ((options.color?.[3] ?? 1) < 1) {
      this.setBlend(true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    gl.useProgram(this.programs[1]);
    gl.uniformMatrix4fv(this.uniforms[1].uMVP, false, options.mvp);
    gl.uniform4f(this.uniforms[1].uColor, ...(options.color || [1, 1, 1, 1]));
    gl.uniform1f(this.uniforms[1].uPointSize, options.pointSize || 1);

    gl.bindVertexArray(this.vaoLine);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.POINTS, 0, vertexCount);
    gl.bindVertexArray(null);

    this.setBlend(prevBlend);
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
          if (this.uniforms[idx].uViewDir) {
            gl.uniform3fv(this.uniforms[idx].uViewDir, this._viewDir);
          }
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
          this.setDepthTest(!!enabled);
          break;
        }

        case CMD_SET_LINE_WIDTH: {
          const w = commandBuffer[pos];
          pos++;
          gl.lineWidth(w);
          break;
        }

        case CMD_SET_DEPTH_WRITE: {
          const enabled = i32View[pos];
          pos++;
          this.setDepthWrite(!!enabled);
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

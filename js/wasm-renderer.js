// wasm-renderer.js — WASM-backed renderer for 2D sketching and 3D viewing
// Loads the AssemblyScript WASM module, manages scene state via WASM exports,
// and uses WebGLExecutor to process batched WebGL commands.

import { WebGLExecutor } from './webgl-executor.js';
import {
  buildMeshRenderData,
  computeFitViewState,
  computeOrbitCameraPosition,
  computeOrbitMvp,
  computeSilhouetteEdges,
} from './render/part-render-core.js';
import { renderBaseMeshOverlay } from './render/mesh-overlay-renderer.js';
import { LodManager } from './render/lod-manager.js';
import { GpuTessPipeline } from './render/gpu-tess-pipeline.js';
import { buildProjectiveGridGuides } from './render/projective-quad.js';
import { SketchFeature } from './cad/SketchFeature.js';
import { constrainedTriangulate } from './cad/Tessellator2/CDT.js';

const MIN_ORBIT_RADIUS = 0.001;
const MAX_ORBIT_RADIUS = 100000;

function _clampOrbitRadius(radius) {
  return Math.max(MIN_ORBIT_RADIUS, Math.min(MAX_ORBIT_RADIUS, radius || MIN_ORBIT_RADIUS));
}

function _cameraClipRange(radius) {
  const r = Math.max(Math.abs(radius || 1), MIN_ORBIT_RADIUS);
  return {
    near: Math.max(1e-6, Math.min(0.1, r * 1e-5)),
    far: Math.max(100000, r * 1000),
  };
}

function _projectPolygon2D(verts, normal) {
  const an = {
    x: Math.abs(normal?.x || 0),
    y: Math.abs(normal?.y || 0),
    z: Math.abs(normal?.z || 0),
  };
  if (an.z >= an.x && an.z >= an.y) {
    return verts.map((v) => ({ x: v.x, y: v.y }));
  }
  if (an.y >= an.x) {
    return verts.map((v) => ({ x: v.x, y: v.z }));
  }
  return verts.map((v) => ({ x: v.y, y: v.z }));
}

function _triangulatePolygonIndices(verts, normal) {
  if (!verts || verts.length < 3) return [];
  if (verts.length === 3) return [[0, 1, 2]];

  const pts2d = _projectPolygon2D(verts, normal);
  let signedArea = 0;
  for (let i = 0; i < pts2d.length; i++) {
    const a = pts2d[i];
    const b = pts2d[(i + 1) % pts2d.length];
    signedArea += a.x * b.y - b.x * a.y;
  }
  const winding = signedArea >= 0 ? 1 : -1;

  function cross2(a, b, c) {
    return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  }

  function pointInTri(p, a, b, c) {
    const c1 = cross2(a, b, p) * winding;
    const c2 = cross2(b, c, p) * winding;
    const c3 = cross2(c, a, p) * winding;
    return c1 >= -1e-8 && c2 >= -1e-8 && c3 >= -1e-8;
  }

  const remaining = verts.map((_, i) => i);
  const triangles = [];
  let guard = 0;
  const maxGuard = verts.length * verts.length;

  while (remaining.length > 3 && guard < maxGuard) {
    let earFound = false;
    for (let ri = 0; ri < remaining.length; ri++) {
      const prev = remaining[(ri - 1 + remaining.length) % remaining.length];
      const curr = remaining[ri];
      const next = remaining[(ri + 1) % remaining.length];
      const a = pts2d[prev];
      const b = pts2d[curr];
      const c = pts2d[next];
      if (cross2(a, b, c) * winding <= 1e-8) continue;

      let containsPoint = false;
      for (const other of remaining) {
        if (other === prev || other === curr || other === next) continue;
        if (pointInTri(pts2d[other], a, b, c)) {
          containsPoint = true;
          break;
        }
      }
      if (containsPoint) continue;

      triangles.push([prev, curr, next]);
      remaining.splice(ri, 1);
      earFound = true;
      break;
    }

    if (!earFound) break;
    guard++;
  }

  if (remaining.length === 3) {
    triangles.push([remaining[0], remaining[1], remaining[2]]);
  }

  if (triangles.length !== Math.max(0, verts.length - 2)) {
    const fan = [];
    for (let i = 1; i < verts.length - 1; i++) fan.push([0, i, i + 1]);
    return fan;
  }
  return triangles;
}

function _getEdgePolylinePoints(edge) {
  if (Array.isArray(edge?.points) && edge.points.length >= 2) return edge.points;
  if (edge?.start && edge?.end) return [edge.start, edge.end];
  return [];
}

function _appendEdgePolylineVertices(out, edge) {
  const points = _getEdgePolylinePoints(edge);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
}

function _buildFaceGroupHighlightVertices(meshTriangles, meshTriangleCount, meshFaces, triFaceMap, targetGroups) {
  if (!meshTriangles || !meshFaces || !triFaceMap || !targetGroups || targetGroups.size === 0) return [];
  const highlightVerts = [];
  const triCount = meshTriangleCount / 3;
  for (let ti = 0; ti < triCount; ti++) {
    const faceIdx = triFaceMap[ti];
    const faceMeta = meshFaces[faceIdx];
    const group = faceMeta ? faceMeta.faceGroup : faceIdx;
    if (!targetGroups.has(group)) continue;
    const base = ti * 3 * 6;
    for (let vi = 0; vi < 3; vi++) {
      const vbase = base + vi * 6;
      highlightVerts.push(
        meshTriangles[vbase], meshTriangles[vbase + 1], meshTriangles[vbase + 2],
        meshTriangles[vbase + 3], meshTriangles[vbase + 4], meshTriangles[vbase + 5],
      );
    }
  }
  return highlightVerts;
}

function _drawFaceHighlightOverlay(gl, exec, mvp, highlightVerts, color) {
  if (!highlightVerts || highlightVerts.length === 0) return;

  const contextAttrs = typeof gl.getContextAttributes === 'function' ? gl.getContextAttributes() : null;
  const hasStencil = !!(contextAttrs && contextAttrs.stencil);
  exec.setBlend(true);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  exec.setDepthFunc(gl.LEQUAL);
  exec.setDepthWrite(false);
  exec.setCullFace(false);

  if (hasStencil) {
    gl.enable(gl.STENCIL_TEST);
    gl.clearStencil(0);
    gl.clear(gl.STENCIL_BUFFER_BIT);
    gl.stencilMask(0xFF);
    gl.stencilFunc(gl.EQUAL, 0, 0xFF);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
  }

  const highlightData = new Float32Array(highlightVerts);
  gl.useProgram(exec.programs[0]);
  gl.uniformMatrix4fv(exec.uniforms[0].uMVP, false, mvp);
  gl.uniform4f(exec.uniforms[0].uColor, color[0], color[1], color[2], color[3]);

  gl.bindVertexArray(exec.vaoSolid);
  gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
  gl.bufferData(gl.ARRAY_BUFFER, highlightData, gl.DYNAMIC_DRAW);
  gl.drawArrays(gl.TRIANGLES, 0, highlightVerts.length / 6);
  gl.bindVertexArray(null);

  if (hasStencil) {
    gl.disable(gl.STENCIL_TEST);
    gl.stencilMask(0xFF);
  }

  exec.setDepthWrite(true);
  exec.setBlend(false);
  exec.setCullFace(true);
  gl.cullFace(gl.BACK);
}

function _lerpPoint(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function _bilinearQuadPoint(quad, u, v) {
  const bl = quad[0];
  const br = quad[1];
  const tr = quad[2];
  const tl = quad[3];
  const bottom = _lerpPoint(bl, br, u);
  const top = _lerpPoint(tl, tr, u);
  return _lerpPoint(bottom, top, v);
}

function _sourceQuadToPixels(sourceQuad, width, height) {
  return sourceQuad.map((point) => ({
    x: (point.u || 0) * width,
    y: (1 - (point.v || 0)) * height,
  }));
}

function _triangleDeterminant(a, b, c) {
  return a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y);
}

function _quadArea(quad) {
  let area = 0;
  for (let i = 0; i < quad.length; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % quad.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) * 0.5;
}

function _transformSourceTriangleToDest(ctx, source, srcTri, dstTri) {
  const denom = _triangleDeterminant(srcTri[0], srcTri[1], srcTri[2]);
  if (Math.abs(denom) < 1e-6) return;

  const a = (dstTri[0].x * (srcTri[1].y - srcTri[2].y) + dstTri[1].x * (srcTri[2].y - srcTri[0].y) + dstTri[2].x * (srcTri[0].y - srcTri[1].y)) / denom;
  const b = (dstTri[0].y * (srcTri[1].y - srcTri[2].y) + dstTri[1].y * (srcTri[2].y - srcTri[0].y) + dstTri[2].y * (srcTri[0].y - srcTri[1].y)) / denom;
  const c = (dstTri[0].x * (srcTri[2].x - srcTri[1].x) + dstTri[1].x * (srcTri[0].x - srcTri[2].x) + dstTri[2].x * (srcTri[1].x - srcTri[0].x)) / denom;
  const d = (dstTri[0].y * (srcTri[2].x - srcTri[1].x) + dstTri[1].y * (srcTri[0].x - srcTri[2].x) + dstTri[2].y * (srcTri[1].x - srcTri[0].x)) / denom;
  const e = (dstTri[0].x * (srcTri[1].x * srcTri[2].y - srcTri[2].x * srcTri[1].y)
    + dstTri[1].x * (srcTri[2].x * srcTri[0].y - srcTri[0].x * srcTri[2].y)
    + dstTri[2].x * (srcTri[0].x * srcTri[1].y - srcTri[1].x * srcTri[0].y)) / denom;
  const f = (dstTri[0].y * (srcTri[1].x * srcTri[2].y - srcTri[2].x * srcTri[1].y)
    + dstTri[1].y * (srcTri[2].x * srcTri[0].y - srcTri[0].x * srcTri[2].y)
    + dstTri[2].y * (srcTri[0].x * srcTri[1].y - srcTri[1].x * srcTri[0].y)) / denom;

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(dstTri[0].x, dstTri[0].y);
  ctx.lineTo(dstTri[1].x, dstTri[1].y);
  ctx.lineTo(dstTri[2].x, dstTri[2].y);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, d, e, f);
  ctx.drawImage(source, 0, 0);
  ctx.restore();
}

function _traceQuadPath(ctx, quad) {
  if (!ctx || !Array.isArray(quad) || quad.length === 0) return;
  ctx.beginPath();
  ctx.moveTo(quad[0].x, quad[0].y);
  for (let index = 1; index < quad.length; index++) {
    ctx.lineTo(quad[index].x, quad[index].y);
  }
  ctx.closePath();
}

function _isIdentitySourceQuad(sourceQuad) {
  const base = [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 1, v: 1 },
    { u: 0, v: 1 },
  ];
  return base.every((point, index) => Math.abs((sourceQuad[index]?.u ?? 0) - point.u) <= 1e-9
    && Math.abs((sourceQuad[index]?.v ?? 0) - point.v) <= 1e-9);
}

/**
 * WasmRenderer — WASM-backed renderer for 2D and 3D views.
 *
 * Public surface used by main.js:
 *   - constructor(container)
 *   - setMode(mode)           '2d' | '3d'
 *   - setVisible(visible)
 *   - onWindowResize()
 *   - sync2DView(viewport)
 *   - render2DScene(scene, overlays)
 *   - renderPart(part)
 *   - clearPartGeometry()
 *   - clearGeometry()
 *   - fitToView()
 *   - screenToWorld(sx, sy)
 *   - dispose()
 *   - renderer.domElement        (the <canvas>)
 */
export class WasmRenderer {
  constructor(container) {
    this.container = container;
    this.mode = '2d';
    this._ready = false;

    // Create a <canvas> that fills the container
    this.canvas = document.createElement('canvas');
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    container.appendChild(this.canvas);

    const width = container.clientWidth || 800;
    const height = container.clientHeight || 600;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = width;
    this.canvas.height = height;

    // WebGL executor
    this.executor = new WebGLExecutor(this.canvas);

    // 2D overlay canvas for text/sprites/dimension labels
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.style.position = 'absolute';
    this.overlayCanvas.style.left = '0';
    this.overlayCanvas.style.top = '0';
    this.overlayCanvas.style.width = '100%';
    this.overlayCanvas.style.height = '100%';
    this.overlayCanvas.style.pointerEvents = 'none';
    this.overlayCanvas.width = Math.round(width * dpr);
    this.overlayCanvas.height = Math.round(height * dpr);
    container.appendChild(this.overlayCanvas);
    this.overlayCtx = this.overlayCanvas.getContext('2d');
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // CSS pixel dimensions (used for coordinate mapping)
    this._cssWidth = width;
    this._cssHeight = height;
    this._last2DScene = null;
    this._last2DOverlays = null;

    // Compatibility shim: renderer.domElement
    this.renderer = { domElement: this.canvas };

    // WASM module handle (set after load)
    this.wasm = null;
    this.wasmMemory = null;

    // View state for 2D
    this._orthoBounds = { left: -500, right: 500, bottom: -375, top: 375 };
    this._cameraPos = { x: 0, y: 0, z: 500 };

    // 3D orbit camera state (spherical coordinates around target)
    this._orbitTheta = Math.PI / 4;   // azimuthal angle (around Z axis)
    this._orbitPhi = Math.PI / 3;     // polar angle (from Z axis)
    this._orbitRadius = 25;
    this._orbitTarget = { x: 0, y: 0, z: 0 };
    this._orbitDirty = true;

    // 3D interaction state
    this._isDragging = false;
    this._isPanning3D = false;
    this._leftClickOrbitEnabled = true;  // default on; host can override via shouldAllowLeftClickOrbit callback
    this._leftClickOrbiting = false;     // true when current drag started with left button
    this.shouldAllowLeftClickOrbit = null; // callback: () => boolean
    this._lastMouseX = 0;
    this._lastMouseY = 0;
    this._ortho3D = false; // orthographic projection in 3D mode
    this._fov = Math.PI / 4; // field of view in radians (default 45°)
    this._fovDegrees = 45;   // FOV in degrees for UI

    // Touch gesture state for 3D controls
    this._touchCount = 0;
    this._touchOrbiting = false;
    this._touchPanning = false;
    this._lastTouchX = 0;
    this._lastTouchY = 0;
    this._lastPinchDist = 0;

    // Callback for camera change events (used by interaction recorder)
    this.onCameraInteraction = null; // (type: 'orbit_start'|'pan_start'|'orbit_end'|'zoom', state) => void

    // Static tessellation density: camera movement must not retessellate or
    // mutate meshes. The quality dropdown owns the selected segment counts.
    // Keep a LodManager instance for API compatibility, but do not drive it
    // from the render loop.
    this._lodManager = new LodManager();
    this.onLodChangeCallback = null;

    // H14/H15: optional WebGPU/WebGL2-backed tessellation pipeline. Created
    // lazily if the environment supports it (`GpuTessPipeline.isAvailable()`),
    // but only activated when `initGpuTessPipeline(registry)` is called with
    // a valid WASM handle registry — matching the SceneRenderer contract so
    // main.js line "this._renderer3d?.initGpuTessPipeline(registry)" actually
    // reaches a real method instead of silently no-op'ing.
    this._gpuTessPipeline = null;
    this._gpuTessReady = false;
    if (typeof GpuTessPipeline.isAvailable === 'function' && GpuTessPipeline.isAvailable()) {
      try {
        this._gpuTessPipeline = new GpuTessPipeline();
      } catch (_) {
        this._gpuTessPipeline = null;
      }
    }

    // Bind 3D mouse controls
    this._bind3DControls();

    // Part data stored for 3D render
    this._partNodes = [];
    this._partBounds = null;
    this._renderedPart = null;

    // Pre-built mesh data for direct WebGL rendering (bypasses WASM scene nodes)
    this._meshRenderCache = new WeakMap();
    this._meshRenderCacheKey = null;
    this._meshRenderGeometry = null;
    this._meshTriangles = null;  // Float32Array: interleaved [x,y,z,nx,ny,nz, ...]
    this._meshTriangleCount = 0;
    this._problemTriangles = null; // Diagnostic triangles for inverted/problem faces
    this._problemTriangleCount = 0;
    this._diagnosticBackfaceHatchEnabled = false;
    this._normalColorShadingEnabled = false;
    this._invisibleEdgesVisible = false;
    this._meshTriangleOverlayMode = 'off';
    this._meshEdges = null;      // Float32Array: [x,y,z, x,y,z, ...] line pairs
    this._meshEdgeVertexCount = 0;
    this._meshDashedFeatureEdges = null;
    this._meshDashedFeatureEdgeVertexCount = 0;
    this._meshTriangleOverlayEdges = null;
    this._meshTriangleOverlayEdgeVertexCount = 0;

    // Sketch wireframe data for rendering sketch primitives in 3D
    this._sketchEdges = null;     // Float32Array: [x,y,z, x,y,z, ...] line pairs (active sketch)
    this._sketchEdgeVertexCount = 0;
    this._sketchInactiveEdges = null;     // Float32Array: inactive sketch edges (grey)
    this._sketchInactiveEdgeVertexCount = 0;
    this._sketchWireframeCache = new Map();
    this._partSketchImages = [];
    this._lastPartSketchImages = [];
    this._imageResources = new Map();

    // Selected faces in 3D mode (multi-select)
    this._selectedFaceIndices = new Set();

    // Edge selection for chamfer/fillet
    this._meshEdgeSegments = null; // Array of {start, end, points?, faceIndices, normals} from CSG
    this._meshEdgePaths = null;    // Array of {edgeIndices, isClosed} from CSG paths
    this._edgeToPath = null;       // Map<edgeIndex, pathIndex>
    this._selectedEdgeIndices = new Set(); // indices into _meshEdgeSegments
    this._edgeSelectionMode = false; // true when picking edges for chamfer/fillet
    this._hoveredEdgeIndex = -1;  // currently hovered edge index (for highlight)
    this._hoveredFaceIndex = -1;  // currently hovered face index (for highlight)

    // Sketch plane reference (set when in sketch-on-plane mode)
    this._sketchPlane = null; // 'XY', 'XZ', 'YZ', or null
    this._originPlaneVisibilityMask = 0b111;
    this._gridVisible = true;
    this._axesVisible = true;

    // Window resize handler
    this._resizeHandler = () => this.onWindowResize();
    window.addEventListener('resize', this._resizeHandler);

    // Load WASM
    this._loadPromise = this._loadWasm();

    // Start animation loop
    this._animationId = null;
    this._animate();
  }

  async _loadWasm() {
    try {
      // Use the ESM bindings generated by AssemblyScript
      const mod = await import('../build/release.js');
      this.wasm = mod;
      const width = this.canvas.width;
      const height = this.canvas.height;
      this.wasm.init(width, height);
      this._ready = true;
      // Apply deferred mode setup now that WASM is loaded
      this.setMode(this.mode);
    } catch (err) {
      console.error('WasmRenderer: failed to load WASM module', err);
    }
  }

  /* ---------- animation loop ---------- */
  _animate() {
    this._animationId = requestAnimationFrame(() => this._animate());
    if (!this._ready) return;
    this._renderFrame();
  }

  _renderFrame() {
    const wasm = this.wasm;
    if (!wasm) return;

    // Update 3D camera from orbit state if dirty
    if (this.mode === '3d' && this._orbitDirty) {
      this._applyOrbitCamera();
      this._orbitDirty = false;
    }

    wasm.render();
    const ptr = wasm.getCommandBufferPtr();
    const len = wasm.getCommandBufferLen();
    if (len <= 0) return;

    // Read command buffer from WASM linear memory
    const memory = wasm.memory || (wasm.__getMemory && wasm.__getMemory());
    if (!memory) return;
    const buf = new Float32Array(memory.buffer, ptr, len);
    this.executor.execute(buf, len);

    // Render Part mesh directly via WebGL (after WASM pass)
    if (this.mode === '3d' || this._sketchPlane) {
      this._renderMeshOverlay();
    }

    if (this.mode === '3d' && !this._sketchPlane) {
      this._renderPartSketchImagesOverlay();
    }

    if (this.onPostRender) this.onPostRender();
  }

  // -----------------------------------------------------------------------
  // Public API for GPU tessellation pipeline and legacy LoD access.
  // -----------------------------------------------------------------------

  /**
   * Initialize the optional GPU tessellation pipeline. Called by main.js
   * during WASM handle subsystem bootstrap. Returns true when the pipeline
   * successfully binds to the registry, false when no pipeline is available
   * (legacy fallback) or initialization fails.
   *
   * @param {object} registry — WASM handle registry from part-manager.js
   * @returns {Promise<boolean>}
   */
  async initGpuTessPipeline(registry) {
    if (!this._gpuTessPipeline || !registry) {
      this._gpuTessReady = false;
      return false;
    }
    try {
      this._gpuTessReady = await this._gpuTessPipeline.init(registry);
    } catch (err) {
      this._gpuTessReady = false;
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('[WasmRenderer] initGpuTessPipeline failed:', err);
      }
    }
    return this._gpuTessReady;
  }

  /**
  * Legacy no-op. Tessellation density is static at the user's selected
  * quality preset; camera-distance LoD retessellation is disabled.
   *
   * Passing null removes the subscription.
   *
   * @param {((segsU:number, segsV:number)=>void)|null} cb
   */
  onLodChange(cb) {
    this.onLodChangeCallback = typeof cb === 'function' ? cb : null;
  }

  /** @returns {LodManager} */
  get lodManager() { return this._lodManager; }

  /** @returns {GpuTessPipeline|null} */
  get gpuTessPipeline() { return this._gpuTessPipeline; }

  /** @returns {boolean} */
  get gpuTessReady() { return this._gpuTessReady; }

  /* ---------- 3D orbit controls ---------- */

  _isSketchNavigationMode() {
    return this.mode === '3d' && !!this._sketchPlaneDef;
  }

  _translateOrbitTargetInSketchPlane(dx, dy) {
    const pd = this._sketchPlaneDef;
    if (!pd) return;
    this._orbitTarget.x += dx * pd.xAxis.x + dy * pd.yAxis.x;
    this._orbitTarget.y += dx * pd.xAxis.y + dy * pd.yAxis.y;
    this._orbitTarget.z += dx * pd.xAxis.z + dy * pd.yAxis.z;
    this._orbitDirty = true;
  }

  _panSketchViewBetweenScreenPoints(fromX, fromY, toX, toY) {
    const pd = this._sketchPlaneDef;
    if (!pd) return false;
    const before = this.rayToPlane(fromX, fromY, pd);
    const after = this.rayToPlane(toX, toY, pd);
    if (!before || !after) return false;
    this._translateOrbitTargetInSketchPlane(before.x - after.x, before.y - after.y);
    return true;
  }

  _zoomSketchViewAt(screenX, screenY, factor) {
    const pd = this._sketchPlaneDef;
    if (!pd) return false;
    const before = this.rayToPlane(screenX, screenY, pd);
    this._orbitRadius = _clampOrbitRadius(this._orbitRadius * factor);
    this._orbitDirty = true;
    this._applyOrbitCamera();
    const after = this.rayToPlane(screenX, screenY, pd);
    if (before && after) {
      this._translateOrbitTargetInSketchPlane(before.x - after.x, before.y - after.y);
      this._applyOrbitCamera();
    }
    return true;
  }

  _bind3DControls() {
    const canvas = this.canvas;

    canvas.addEventListener('mousedown', (e) => {
      if (this.mode !== '3d') return;
      const sketchNavigation = this._isSketchNavigationMode();
      // Left button = orbit (when allowed), Middle button = orbit, Right button = pan
      const allowLeftOrbit = this._leftClickOrbitEnabled
        && (!this.shouldAllowLeftClickOrbit || this.shouldAllowLeftClickOrbit());
      if (e.button === 0 && allowLeftOrbit && (!sketchNavigation || e.shiftKey)) {
        e.preventDefault();
        this._isDragging = true;
        this._isPanning3D = false;
        this._leftClickOrbiting = true;
        if (this.onCameraInteraction) this.onCameraInteraction('orbit_start', this.getOrbitState());
      } else if (e.button === 1 && (!sketchNavigation || e.shiftKey)) {
        e.preventDefault();
        this._isDragging = true;
        this._isPanning3D = false;
        this._leftClickOrbiting = false;
        if (this.onCameraInteraction) this.onCameraInteraction('orbit_start', this.getOrbitState());
      } else if (e.button === 1 && sketchNavigation) {
        e.preventDefault();
        this._isPanning3D = true;
        this._isDragging = false;
        this._leftClickOrbiting = false;
        if (this.onCameraInteraction) this.onCameraInteraction('pan_start', this.getOrbitState());
      } else if (e.button === 2) {
        e.preventDefault();
        this._isPanning3D = true;
        this._isDragging = false;
        if (this.onCameraInteraction) this.onCameraInteraction('pan_start', this.getOrbitState());
      }
      this._lastMouseX = e.clientX;
      this._lastMouseY = e.clientY;
    });

    canvas.addEventListener('mousemove', (e) => {
      if (this.mode !== '3d') return;
      const dx = e.clientX - this._lastMouseX;
      const dy = e.clientY - this._lastMouseY;
      const previousX = this._lastMouseX;
      const previousY = this._lastMouseY;
      this._lastMouseX = e.clientX;
      this._lastMouseY = e.clientY;

      if (this._isDragging) {
        // Orbit: adjust theta (azimuth) and phi (elevation)
        this._orbitTheta -= dx * 0.005;
        this._orbitPhi -= dy * 0.005;
        // Clamp phi to avoid flipping
        this._orbitPhi = Math.max(0.05, Math.min(Math.PI - 0.05, this._orbitPhi));
        this._orbitDirty = true;
      } else if (this._isPanning3D) {
        if (this._isSketchNavigationMode() && !e.shiftKey) {
          this._panSketchViewBetweenScreenPoints(previousX, previousY, e.clientX, e.clientY);
          return;
        }
        // Pan: move target in the camera's local right/up plane
        const panSpeed = this._orbitRadius * 0.001;
        const theta = this._orbitTheta;
        const phi = this._orbitPhi;

        // Camera right vector (perpendicular to view direction in XY plane)
        const rightX = -Math.sin(theta);
        const rightY = Math.cos(theta);
        // Camera up vector (world Z projected)
        const upX = -Math.cos(theta) * Math.cos(phi);
        const upY = -Math.sin(theta) * Math.cos(phi);
        const upZ = Math.sin(phi);

        this._orbitTarget.x += (-dx * rightX + dy * upX) * panSpeed;
        this._orbitTarget.y += (-dx * rightY + dy * upY) * panSpeed;
        this._orbitTarget.z += dy * upZ * panSpeed;
        this._orbitDirty = true;
      }
    });

    canvas.addEventListener('mouseup', () => {
      const wasDragging = this._isDragging || this._isPanning3D;
      this._isDragging = false;
      this._isPanning3D = false;
      this._leftClickOrbiting = false;
      if (wasDragging && this.onCameraInteraction) this.onCameraInteraction('orbit_end', this.getOrbitState());
    });

    canvas.addEventListener('mouseleave', () => {
      this._isDragging = false;
      this._isPanning3D = false;
      this._leftClickOrbiting = false;
    });

    canvas.addEventListener('wheel', (e) => {
      if (this.mode !== '3d') return;
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.1 : 0.9;
      if (this._isSketchNavigationMode() && !e.shiftKey) {
        const rect = canvas.getBoundingClientRect();
        this._zoomSketchViewAt(e.clientX - rect.left, e.clientY - rect.top, factor);
        if (this.onCameraInteraction) this.onCameraInteraction('zoom', this.getOrbitState());
        return;
      }
      this._orbitRadius *= factor;
      this._orbitRadius = _clampOrbitRadius(this._orbitRadius);
      this._orbitDirty = true;
      if (this.onCameraInteraction) this.onCameraInteraction('zoom', this.getOrbitState());
    }, { passive: false });

    // --- Touch gesture controls for 3D orbit/pan/zoom ---

    canvas.addEventListener('touchstart', (e) => {
      if (this.mode !== '3d') return;
      // Let the host (App) handle sketch-mode single-touch drawing;
      // only handle multi-touch or 3D-navigation single-touch here.
      if (this.onTouchStart && this.onTouchStart(e)) return;

      e.preventDefault();
      this._touchCount = e.touches.length;

      if (e.touches.length === 1) {
        // Single finger: orbit
        this._touchOrbiting = true;
        this._touchPanning = false;
        this._lastTouchX = e.touches[0].clientX;
        this._lastTouchY = e.touches[0].clientY;
        if (this.onCameraInteraction) this.onCameraInteraction('orbit_start', this.getOrbitState());
      } else if (e.touches.length === 2) {
        // Two fingers: pan + pinch zoom
        this._touchOrbiting = false;
        this._touchPanning = true;
        const t0 = e.touches[0], t1 = e.touches[1];
        this._lastPinchCenterX = (t0.clientX + t1.clientX) / 2;
        this._lastPinchCenterY = (t0.clientY + t1.clientY) / 2;
        this._lastTouchX = this._lastPinchCenterX;
        this._lastTouchY = this._lastPinchCenterY;
        this._lastPinchDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
        if (this.onCameraInteraction) this.onCameraInteraction('pan_start', this.getOrbitState());
      }
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
      if (this.mode !== '3d') return;
      if (this.onTouchMove && this.onTouchMove(e)) return;

      e.preventDefault();

      if (e.touches.length === 1 && this._touchOrbiting) {
        // Single finger orbit
        const dx = e.touches[0].clientX - this._lastTouchX;
        const dy = e.touches[0].clientY - this._lastTouchY;
        this._lastTouchX = e.touches[0].clientX;
        this._lastTouchY = e.touches[0].clientY;

        this._orbitTheta -= dx * 0.005;
        this._orbitPhi -= dy * 0.005;
        this._orbitPhi = Math.max(0.05, Math.min(Math.PI - 0.05, this._orbitPhi));
        this._orbitDirty = true;
      } else if (e.touches.length === 2) {
        // Two-finger pan + pinch zoom
        const t0 = e.touches[0], t1 = e.touches[1];
        const cx = (t0.clientX + t1.clientX) / 2;
        const cy = (t0.clientY + t1.clientY) / 2;
        const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);

        // Pinch zoom
        if (this._lastPinchDist > 0 && dist > 0) {
          const scale = this._lastPinchDist / dist;
          this._orbitRadius *= scale;
          this._orbitRadius = _clampOrbitRadius(this._orbitRadius);
          this._orbitDirty = true;
        }

        // Pan
        const dx = cx - this._lastTouchX;
        const dy = cy - this._lastTouchY;
        if (Math.abs(dx) > 0.1 || Math.abs(dy) > 0.1) {
          const panSpeed = this._orbitRadius * 0.001;
          const theta = this._orbitTheta;
          const phi = this._orbitPhi;
          const rightX = -Math.sin(theta);
          const rightY = Math.cos(theta);
          const upX = -Math.cos(theta) * Math.cos(phi);
          const upY = -Math.sin(theta) * Math.cos(phi);
          const upZ = Math.sin(phi);

          this._orbitTarget.x += (-dx * rightX + dy * upX) * panSpeed;
          this._orbitTarget.y += (-dx * rightY + dy * upY) * panSpeed;
          this._orbitTarget.z += dy * upZ * panSpeed;
          this._orbitDirty = true;
        }

        this._lastTouchX = cx;
        this._lastTouchY = cy;
        this._lastPinchDist = dist;
      }
    }, { passive: false });

    canvas.addEventListener('touchend', (e) => {
      if (this.mode !== '3d') return;
      if (this.onTouchEnd && this.onTouchEnd(e)) return;

      const wasTouching = this._touchOrbiting || this._touchPanning;
      if (e.touches.length === 0) {
        this._touchOrbiting = false;
        this._touchPanning = false;
        this._touchCount = 0;
        if (wasTouching && this.onCameraInteraction) this.onCameraInteraction('orbit_end', this.getOrbitState());
      } else if (e.touches.length === 1) {
        // Went from 2 fingers to 1: switch to orbit
        this._touchPanning = false;
        this._touchOrbiting = true;
        this._touchCount = 1;
        this._lastTouchX = e.touches[0].clientX;
        this._lastTouchY = e.touches[0].clientY;
      }
    }, { passive: false });

    canvas.addEventListener('touchcancel', () => {
      this._touchOrbiting = false;
      this._touchPanning = false;
      this._touchCount = 0;
      this._lastPinchDist = 0;
    });
  }

  _applyOrbitCamera() {
    if (!this._ready) return;
    const t = this._orbitTarget;
    this._orbitRadius = _clampOrbitRadius(this._orbitRadius);
    const clip = _cameraClipRange(this._orbitRadius);
    const camera = computeOrbitCameraPosition(this._orbitTheta, this._orbitPhi, this._orbitRadius, t);

    this.wasm.setCameraPosition(camera.x, camera.y, camera.z);
    this.wasm.setCameraTarget(t.x, t.y, t.z);
    if (typeof this.wasm.setCameraClipPlanes === 'function') {
      this.wasm.setCameraClipPlanes(clip.near, clip.far);
    }

    // Apply orthographic or perspective projection for 3D mode
    if (this._ortho3D || this._fovDegrees <= 0) {
      this.wasm.setCameraMode(1);
      const w = this._cssWidth || this.container.clientWidth || 800;
      const h = this._cssHeight || this.container.clientHeight || 600;
      const aspect = w / h;
      const halfH = this._orbitRadius * 0.5;
      const halfW = halfH * aspect;
      // Ortho bounds must be view-space (centered at origin) since the
      // lookAt view matrix already positions the camera relative to target.
      this.wasm.setOrthoBounds(-halfW, halfW, -halfH, halfH);
    } else {
      // Always sync WASM FOV before setting perspective mode so the grid
      // and model use the same field of view (prevents mismatch on refresh).
      this.wasm.setFov(this._fov);
      this.wasm.setCameraMode(1);
    }
    if (this.wasm.setOriginPlanesVisible) {
      this.wasm.setOriginPlanesVisible(this._originPlaneVisibilityMask);
    }
  }

  /**
   * Set orthographic projection for 3D mode.
   * @param {boolean} enabled
   */
  setOrtho3D(enabled) {
    this._ortho3D = enabled;
    if (this.mode === '3d') {
      this._orbitDirty = true;
    }
  }

  /**
   * Set the field of view in degrees. 0 = orthographic, 120 = ultra-wide.
   * Adjusts orbit radius to keep the visible extent roughly constant.
   * @param {number} degrees
   */
  setFOV(degrees) {
    const newDeg = Math.max(0, Math.min(120, degrees));
    const oldDeg = this._fovDegrees;

    // Compensate orbit radius so apparent object size stays constant.
    // Visible half-height: perspective = r * tan(fov/2), ortho = r * 0.5
    if (newDeg !== oldDeg) {
      const ORTHO_K = 0.5;
      const oldH = oldDeg > 0 ? Math.tan((oldDeg * Math.PI / 180) / 2) : ORTHO_K;
      const newH = newDeg > 0 ? Math.tan((newDeg * Math.PI / 180) / 2) : ORTHO_K;
      this._orbitRadius = _clampOrbitRadius(this._orbitRadius * oldH / newH);
    }

    this._fovDegrees = newDeg;
    this._fov = this._fovDegrees * Math.PI / 180;
    // Sync WASM camera FOV and mode
    if (this._ready) {
      if (this._fovDegrees <= 0) {
        this.wasm.setCameraMode(1);
      } else {
        this.wasm.setFov(this._fov);
        this.wasm.setCameraMode(1);
      }
    }
    this._orbitDirty = true;
  }

  /** @returns {number} Current FOV in degrees */
  getFOV() { return this._fovDegrees; }

  /**
   * Project a sketch-local 2D coordinate to screen (CSS) pixel coordinates.
   * Uses the active _sketchPlaneDef to transform from local 2D → world 3D,
   * then the perspective/ortho MVP to project to screen.
   * @param {number} lx - Local X in sketch plane
   * @param {number} ly - Local Y in sketch plane
   * @returns {{x:number, y:number}|null}
   */
  sketchToScreen(lx, ly) {
    const pd = this._sketchPlaneDef;
    if (!pd) return null;
    const mvp = this._computeMVP();
    if (!mvp) return null;
    // local 2D → world 3D
    const wx = pd.origin.x + lx * pd.xAxis.x + ly * pd.yAxis.x;
    const wy = pd.origin.y + lx * pd.xAxis.y + ly * pd.yAxis.y;
    const wz = pd.origin.z + lx * pd.xAxis.z + ly * pd.yAxis.z;
    // project
    const clip = this._mat4TransformVec4(mvp, wx, wy, wz, 1);
    if (Math.abs(clip.w) < 1e-10) return null;
    const ndcX = clip.x / clip.w;
    const ndcY = clip.y / clip.w;
    const w = this._cssWidth || this.container.clientWidth;
    const h = this._cssHeight || this.container.clientHeight;
    return {
      x: (ndcX * 0.5 + 0.5) * w,
      y: (1 - (ndcY * 0.5 + 0.5)) * h,
    };
  }

  /**
   * Project a 3D world-space point to screen pixel coordinates.
   * @param {number} wx - World X
   * @param {number} wy - World Y
   * @param {number} wz - World Z
   * @returns {{x:number, y:number}|null} Screen pixel position or null
   */
  worldToScreen(wx, wy, wz) {
    const mvp = this._computeMVP();
    if (!mvp) return null;
    const clip = this._mat4TransformVec4(mvp, wx, wy, wz, 1);
    if (Math.abs(clip.w) < 1e-10) return null;
    const ndcX = clip.x / clip.w;
    const ndcY = clip.y / clip.w;
    const w = this._cssWidth || this.container.clientWidth;
    const h = this._cssHeight || this.container.clientHeight;
    return {
      x: (ndcX * 0.5 + 0.5) * w,
      y: (1 - (ndcY * 0.5 + 0.5)) * h,
    };
  }

  /** Returns true if there is an active sketch plane definition set. */
  hasSketchPlane() {
    return !!this._sketchPlaneDef;
  }

  /**
   * Orient the orbit camera perpendicular to the given plane.
   * @param {'XY'|'XZ'|'YZ'} plane - The reference plane
   */
  orientToPlane(plane) {
    switch (plane) {
      case 'XY':
        // Look down the Z axis (top view): phi≈0 means camera on +Z.
        // theta = -π/2 offsets toward -Y so cross(forward, up) gives +X right.
        this._orbitTheta = -Math.PI / 2;
        this._orbitPhi = 0.001; // near 0 to look straight down +Z
        break;
      case 'XZ':
        // Look along the Y axis (front view): camera on -Y looking toward +Y.
        // theta = -π/2 ensures screen-right = +X, screen-up = +Z.
        this._orbitTheta = -Math.PI / 2;
        this._orbitPhi = Math.PI / 2;
        break;
      case 'YZ':
        // Look down the X axis (right view): camera on +X looking at origin
        this._orbitTheta = 0;
        this._orbitPhi = Math.PI / 2;
        break;
      default:
        return;
    }
    this._orbitDirty = true;
    this._applyOrbitCamera();
  }

  /**
   * Orient the orbit camera perpendicular to a plane defined by a normal vector.
   * @param {{x:number, y:number, z:number}} normal - The plane normal
   * @param {{x:number, y:number, z:number}} [center] - Optional center point to look at
   */
  orientToPlaneNormal(normal, center) {
    // Convert normal direction to spherical coordinates (theta, phi)
    const nx = normal.x, ny = normal.y, nz = normal.z;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-10) return;
    const dnx = nx / len, dny = ny / len, dnz = nz / len;

    // phi is angle from Z axis: acos(nz)
    this._orbitPhi = Math.acos(Math.max(-1, Math.min(1, dnz)));
    // theta is angle in XY plane: atan2(ny, nx)
    // For normals aligned with Z axis, atan2(0,0)=0 which differs from
    // orientToPlane('XY') convention of theta=-π/2. Use the same value
    // so that reload and initial entry produce the same view.
    if (Math.abs(dnx) < 1e-6 && Math.abs(dny) < 1e-6) {
      this._orbitTheta = -Math.PI / 2;
    } else {
      this._orbitTheta = Math.atan2(dny, dnx);
    }

    // Clamp phi to avoid degeneracies
    if (this._orbitPhi < 0.001) this._orbitPhi = 0.001;
    if (this._orbitPhi > Math.PI - 0.001) this._orbitPhi = Math.PI - 0.001;

    if (center) {
      this._orbitTarget = { x: center.x, y: center.y, z: center.z };
    }

    this._orbitDirty = true;
    this._applyOrbitCamera();
  }

  /**
   * Save the current orbit camera state so it can be restored later.
   * @returns {{theta: number, phi: number, radius: number, target: {x:number,y:number,z:number}, fovDegrees: number, ortho3D: boolean}}
   */
  saveOrbitState() {
    return {
      theta: this._orbitTheta,
      phi: this._orbitPhi,
      radius: this._orbitRadius,
      target: { ...this._orbitTarget },
      fovDegrees: this._fovDegrees,
      ortho3D: this._ortho3D,
    };
  }

  /**
   * Restore a previously saved orbit camera state.
   * @param {{theta: number, phi: number, radius: number, target: {x:number,y:number,z:number}, fovDegrees?: number, ortho3D?: boolean}} state
   */
  restoreOrbitState(state) {
    if (!state) return;
    this._orbitTheta = state.theta;
    this._orbitPhi = state.phi;
    this._orbitTarget = { ...state.target };
    if (state.ortho3D != null) this.setOrtho3D(state.ortho3D);
    if (state.fovDegrees != null) {
      // Set FOV first (which adjusts radius via compensation),
      // then override radius with the exact saved value.
      this.setFOV(state.fovDegrees);
    }
    this._orbitRadius = _clampOrbitRadius(state.radius);
    this._orbitDirty = true;
    this._applyOrbitCamera();
  }

  /**
   * Pick a face at the given screen coordinates using ray-triangle intersection.
   * @param {number} screenX - Screen X coordinate
   * @param {number} screenY - Screen Y coordinate
   * @returns {{faceIndex: number, face: Object, point: {x:number,y:number,z:number}}|null}
   */
  pickFace(screenX, screenY) {
    if (!this._meshTriangles || this._meshTriangleCount === 0 || !this._meshFaces) return null;

    const ray = this._computePickRay(screenX, screenY);
    if (!ray) return null;
    const { origin, dir } = ray;

    // Test ray against all triangles
    let closestT = Infinity;
    let closestFaceIndex = -1;
    let closestPoint = null;

    const triData = this._meshTriangles;
    const triCount = this._meshTriangleCount / 3; // number of triangles
    for (let ti = 0; ti < triCount; ti++) {
      const base = ti * 3 * 6; // 3 vertices * 6 floats each
      const v0 = { x: triData[base], y: triData[base + 1], z: triData[base + 2] };
      const v1 = { x: triData[base + 6], y: triData[base + 7], z: triData[base + 8] };
      const v2 = { x: triData[base + 12], y: triData[base + 13], z: triData[base + 14] };

      const t = this._rayTriangleIntersect(origin, dir, v0, v1, v2);
      if (t !== null && t > 0 && t < closestT) {
        closestT = t;
        closestFaceIndex = this._triFaceMap ? this._triFaceMap[ti] : -1;
        closestPoint = {
          x: origin.x + dir.x * t,
          y: origin.y + dir.y * t,
          z: origin.z + dir.z * t,
        };
      }
    }

    if (closestFaceIndex >= 0 && closestPoint) {
      return {
        faceIndex: closestFaceIndex,
        face: this._meshFaces[closestFaceIndex],
        point: closestPoint,
      };
    }
    return null;
  }

  /**
   * Pick a sketch feature at the given screen coordinates using sketch wireframes
   * first and sketch face triangles as a fallback.
   * @param {number} screenX - Screen X coordinate
   * @param {number} screenY - Screen Y coordinate
   * @param {{includeFaces?: boolean}} [options]
   * @returns {{featureId: string}|null}
   */
  pickSketch(screenX, screenY, options = {}) {
    const includeFaces = options.includeFaces !== false;
    const hasSegments = !!(this._sketchPickSegments && this._sketchPickSegments.length > 0);
    const hasTriangles = includeFaces && !!(this._sketchPickTriangles && this._sketchPickTriangles.length > 0);
    if (!hasSegments && !hasTriangles) return null;

    const ray = this._computePickRay(screenX, screenY);
    if (!ray) return null;
    const { origin, dir, mvp, ndcX, ndcY, rect } = ray;

    // Screen-space pixel threshold for picking (in pixels)
    const pixelThreshold = 12;
    let closestDist = Infinity;
    let closestFeatureId = null;
    let closestWorldPt = null;

    if (hasSegments) {
      for (const entry of this._sketchPickSegments) {
        for (const seg of entry.segments) {
          const result = this._rayLineClosest(origin, dir, seg.a, seg.b);
          if (result.dist < closestDist) {
            closestDist = result.dist;
            closestFeatureId = entry.featureId;
            closestWorldPt = result.point;
          }
        }
      }
    }

    // Project the closest world point to screen and measure pixel distance
    if (closestFeatureId !== null && closestWorldPt) {
      const projected = this._mat4TransformVec4(mvp, closestWorldPt.x, closestWorldPt.y, closestWorldPt.z, 1);
      if (Math.abs(projected.w) > 1e-10) {
        const pNdcX = projected.x / projected.w;
        const pNdcY = projected.y / projected.w;
        const screenDistX = ((pNdcX - ndcX) / 2) * rect.width;
        const screenDistY = ((pNdcY - ndcY) / 2) * rect.height;
        const screenDist = Math.sqrt(screenDistX * screenDistX + screenDistY * screenDistY);
        if (screenDist < pixelThreshold) {
          return { featureId: closestFeatureId };
        }
      }
    }

    if (hasTriangles) {
      let closestTriangleT = Infinity;
      let closestTriangleFeatureId = null;
      for (const entry of this._sketchPickTriangles) {
        for (const tri of entry.triangles) {
          const t = this._rayTriangleIntersect(origin, dir, tri[0], tri[1], tri[2]);
          if (t != null && t < closestTriangleT) {
            closestTriangleT = t;
            closestTriangleFeatureId = entry.featureId;
          }
        }
      }
      if (closestTriangleFeatureId !== null) {
        return { featureId: closestTriangleFeatureId };
      }
    }

    return null;
  }

  /**
   * Pick the closest edge at screen coordinates.
   * Uses ray-line closest distance with screen-space pixel threshold.
   * @param {number} screenX
   * @param {number} screenY
   * @returns {{edgeIndex: number, edge: Object, point: {x,y,z}}|null}
   */
  pickEdge(screenX, screenY) {
    if (!this._meshEdgeSegments || this._meshEdgeSegments.length === 0) return null;

    const ray = this._computePickRay(screenX, screenY);
    if (!ray) return null;
    const { origin, dir, mvp, ndcX, ndcY, rect } = ray;

    const pixelThreshold = 12;
    let closestDist = Infinity;
    let closestIdx = -1;
    let closestWorldPt = null;

    for (let i = 0; i < this._meshEdgeSegments.length; i++) {
      const seg = this._meshEdgeSegments[i];
      const points = _getEdgePolylinePoints(seg);
      for (let pi = 1; pi < points.length; pi++) {
        const result = this._rayLineClosest(origin, dir, points[pi - 1], points[pi]);
        if (result.dist < closestDist) {
          closestDist = result.dist;
          closestIdx = i;
          closestWorldPt = result.point;
        }
      }
    }

    if (closestIdx >= 0 && closestWorldPt) {
      const projected = this._mat4TransformVec4(mvp, closestWorldPt.x, closestWorldPt.y, closestWorldPt.z, 1);
      if (Math.abs(projected.w) > 1e-10) {
        const pNdcX = projected.x / projected.w;
        const pNdcY = projected.y / projected.w;
        const screenDistX = ((pNdcX - ndcX) / 2) * rect.width;
        const screenDistY = ((pNdcY - ndcY) / 2) * rect.height;
        const screenDist = Math.sqrt(screenDistX * screenDistX + screenDistY * screenDistY);
        if (screenDist < pixelThreshold) {
          return {
            edgeIndex: closestIdx,
            edge: this._meshEdgeSegments[closestIdx],
            point: closestWorldPt,
          };
        }
      }
    }
    return null;
  }

  /**
   * Toggle edge selection. Selects/deselects the entire path containing the edge.
   */
  toggleEdgeSelection(edgeIndex) {
    // Find the path this edge belongs to
    const pathIdx = this._edgeToPath ? this._edgeToPath.get(edgeIndex) : undefined;
    if (pathIdx !== undefined && this._meshEdgePaths) {
      const path = this._meshEdgePaths[pathIdx];
      // Check if any edge in the path is already selected → deselect all
      const anySelected = path.edgeIndices.some(i => this._selectedEdgeIndices.has(i));
      if (anySelected) {
        for (const i of path.edgeIndices) this._selectedEdgeIndices.delete(i);
      } else {
        for (const i of path.edgeIndices) this._selectedEdgeIndices.add(i);
      }
    } else {
      // Fallback: single edge toggle
      if (this._selectedEdgeIndices.has(edgeIndex)) {
        this._selectedEdgeIndices.delete(edgeIndex);
      } else {
        this._selectedEdgeIndices.add(edgeIndex);
      }
    }
    return this._selectedEdgeIndices;
  }

  /** Clear all selected edges. */
  clearEdgeSelection() {
    this._selectedEdgeIndices.clear();
  }

  /** Get selected edge metadata array. */
  getSelectedEdges() {
    if (!this._meshEdgeSegments) return [];
    return [...this._selectedEdgeIndices].map(i => this._meshEdgeSegments[i]).filter(Boolean);
  }

  /** Set edge selection mode. */
  setEdgeSelectionMode(enabled) {
    this._edgeSelectionMode = enabled;
    if (!enabled) this.clearEdgeSelection();
  }

  /**
   * Programmatically select edges by their position-based keys.
   * Used to pre-select edges when editing an existing chamfer/fillet feature.
   * @param {string[]} edgeKeys - Array of edge key strings (e.g. "x1,y1,z1|x2,y2,z2")
   */
  selectEdgesByKeys(edgeKeys) {
    if (!this._meshEdgeSegments) return;
    const keySet = new Set(edgeKeys);
    const prec = 5;
    const vk = (v) => `${v.x.toFixed(prec)},${v.y.toFixed(prec)},${v.z.toFixed(prec)}`;
    for (let i = 0; i < this._meshEdgeSegments.length; i++) {
      const seg = this._meshEdgeSegments[i];
      const ka = vk(seg.start), kb = vk(seg.end);
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (keySet.has(ek)) {
        this._selectedEdgeIndices.add(i);
      }
    }
  }

  /**
   * Get all edge indices that border a given face.
   * @param {number} faceIndex
   * @returns {number[]} edge indices
   */
  getEdgeIndicesForFace(faceIndex) {
    if (!this._meshEdgeSegments) return [];
    const result = [];
    for (let i = 0; i < this._meshEdgeSegments.length; i++) {
      const seg = this._meshEdgeSegments[i];
      if (seg.faceIndices && seg.faceIndices.includes(faceIndex)) {
        result.push(i);
      }
    }
    return result;
  }

  /**
   * Select all edges around a face (add to selection).
   * @param {number} faceIndex
   */
  selectEdgesForFace(faceIndex) {
    const edgeIndices = this.getEdgeIndicesForFace(faceIndex);
    for (const i of edgeIndices) {
      this._selectedEdgeIndices.add(i);
    }
  }

  /**
   * Add a single edge (by path) to the selection without toggling.
   * @param {number} edgeIndex
   */
  addEdgeSelection(edgeIndex) {
    const pathIdx = this._edgeToPath ? this._edgeToPath.get(edgeIndex) : undefined;
    if (pathIdx !== undefined && this._meshEdgePaths) {
      const path = this._meshEdgePaths[pathIdx];
      for (const i of path.edgeIndices) this._selectedEdgeIndices.add(i);
    } else {
      this._selectedEdgeIndices.add(edgeIndex);
    }
  }

  /**
   * Remove a single edge (by path) from the selection without toggling.
   * @param {number} edgeIndex
   */
  removeEdgeSelection(edgeIndex) {
    const pathIdx = this._edgeToPath ? this._edgeToPath.get(edgeIndex) : undefined;
    if (pathIdx !== undefined && this._meshEdgePaths) {
      const path = this._meshEdgePaths[pathIdx];
      for (const i of path.edgeIndices) this._selectedEdgeIndices.delete(i);
    } else {
      this._selectedEdgeIndices.delete(edgeIndex);
    }
  }

  /**
   * Set the hovered edge index for highlight rendering. Pass -1 to clear.
   * @param {number} edgeIndex
   */
  setHoveredEdge(edgeIndex) {
    this._hoveredEdgeIndex = edgeIndex;
  }

  /**
   * Set the hovered face index for highlight rendering. Pass -1 to clear.
   * @param {number} faceIndex
   */
  setHoveredFace(faceIndex) {
    this._hoveredFaceIndex = faceIndex;
  }

  /**
   * Get selected edge keys as position-based strings.
   * @returns {string[]} Array of edge key strings
   */
  getSelectedEdgeKeys() {
    const edges = this.getSelectedEdges();
    const prec = 5;
    const vk = (v) => `${v.x.toFixed(prec)},${v.y.toFixed(prec)},${v.z.toFixed(prec)}`;
    return edges.map(e => {
      const ka = vk(e.start), kb = vk(e.end);
      return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
    });
  }

  /**
   * Check if an edge (by path) is currently selected.
   * @param {number} edgeIndex
   * @returns {boolean}
   */
  isEdgeSelected(edgeIndex) {
    const pathIdx = this._edgeToPath ? this._edgeToPath.get(edgeIndex) : undefined;
    if (pathIdx !== undefined && this._meshEdgePaths) {
      const path = this._meshEdgePaths[pathIdx];
      return path.edgeIndices.some(i => this._selectedEdgeIndices.has(i));
    }
    return this._selectedEdgeIndices.has(edgeIndex);
  }

  /**
   * Render a preview geometry (chamfer/fillet preview) instead of the actual part.
   * Builds the mesh from the geometry and triggers a re-render.
   * @param {Object} geometry - Geometry object with .faces, .edges, .paths
   */
  renderPreviewGeometry(geometry) {
    if (!geometry) return;
    this._buildMeshFromGeometry(geometry);
  }

  /**
   * Compute the minimum distance between a ray and a line segment in 3D.
   * @param {{x:number,y:number,z:number}} rayOrigin
   * @param {{x:number,y:number,z:number}} rayDir - Normalized ray direction
   * @param {{x:number,y:number,z:number}} segA - Segment start
   * @param {{x:number,y:number,z:number}} segB - Segment end
   * @returns {number} Minimum distance
   */
  _rayLineDistance(rayOrigin, rayDir, segA, segB) {
    return this._rayLineClosest(rayOrigin, rayDir, segA, segB).dist;
  }

  /**
   * Compute the minimum distance between a ray and a line segment in 3D,
   * returning both the distance and the closest point on the segment.
   */
  _rayLineClosest(rayOrigin, rayDir, segA, segB) {
    // Line segment direction
    const dx = segB.x - segA.x, dy = segB.y - segA.y, dz = segB.z - segA.z;
    const wx = rayOrigin.x - segA.x, wy = rayOrigin.y - segA.y, wz = rayOrigin.z - segA.z;

    const a = rayDir.x * rayDir.x + rayDir.y * rayDir.y + rayDir.z * rayDir.z; // = 1 (normalized)
    const b = rayDir.x * dx + rayDir.y * dy + rayDir.z * dz;
    const c = dx * dx + dy * dy + dz * dz;
    const d = rayDir.x * wx + rayDir.y * wy + rayDir.z * wz;
    const e = dx * wx + dy * wy + dz * wz;

    const denom = a * c - b * b;
    let sN, sD = denom, tN, tD = denom;

    if (denom < 1e-10) {
      // Lines are parallel
      sN = 0; sD = 1; tN = e; tD = c;
    } else {
      sN = b * e - c * d;
      tN = a * e - b * d;
    }

    // Clamp t (segment parameter) to [0, 1]
    if (tN < 0) { tN = 0; sN = -d; sD = a; }
    else if (tN > tD) { tN = tD; sN = b - d; sD = a; }

    // Clamp s (ray parameter) to >= 0
    const sc = Math.abs(sN) < 1e-10 ? 0 : Math.max(0, sN / sD);
    const tc = Math.abs(tN) < 1e-10 ? 0 : tN / tD;

    // Closest points
    const px = wx + sc * rayDir.x - tc * dx;
    const py = wy + sc * rayDir.y - tc * dy;
    const pz = wz + sc * rayDir.z - tc * dz;

    return {
      dist: Math.sqrt(px * px + py * py + pz * pz),
      point: { x: segA.x + tc * dx, y: segA.y + tc * dy, z: segA.z + tc * dz },
    };
  }

  /**
   * Select exactly one face (clears previous selection). Pass -1 to clear.
   * @param {number} faceIndex
   */
  selectFace(faceIndex) {
    this._selectedFaceIndices.clear();
    if (faceIndex >= 0) this._selectedFaceIndices.add(faceIndex);
  }

  /** Add a face to the current selection. */
  addFaceSelection(faceIndex) {
    if (faceIndex >= 0) this._selectedFaceIndices.add(faceIndex);
  }

  /** Remove a face from the current selection. */
  removeFaceSelection(faceIndex) {
    this._selectedFaceIndices.delete(faceIndex);
  }

  /** Toggle a face in the selection. */
  toggleFaceSelection(faceIndex) {
    if (this._selectedFaceIndices.has(faceIndex)) {
      this._selectedFaceIndices.delete(faceIndex);
    } else if (faceIndex >= 0) {
      this._selectedFaceIndices.add(faceIndex);
    }
  }

  /** Clear all selected faces. */
  clearFaceSelection() {
    this._selectedFaceIndices.clear();
  }

  /** Check if a face is currently selected. */
  isFaceSelected(faceIndex) {
    return this._selectedFaceIndices.has(faceIndex);
  }

  /**
   * Get the first selected face index (backward compat).
   * @returns {number} face index or -1 if none
   */
  getSelectedFaceIndex() {
    if (this._selectedFaceIndices.size === 0) return -1;
    return this._selectedFaceIndices.values().next().value;
  }

  /** Return the current 3D orbit camera state for persistence. */
  getOrbitState() {
    return {
      theta: this._orbitTheta,
      phi: this._orbitPhi,
      radius: this._orbitRadius,
      target: { ...this._orbitTarget },
      fovDegrees: this._fovDegrees,
      ortho3D: this._ortho3D,
    };
  }

  /** Restore 3D orbit camera state from a previously saved object. */
  setOrbitState(s) {
    if (!s) return;
    if (s.theta != null) this._orbitTheta = s.theta;
    if (s.phi != null) this._orbitPhi = s.phi;
    if (s.radius != null) this._orbitRadius = _clampOrbitRadius(s.radius);
    if (s.target) this._orbitTarget = { x: s.target.x || 0, y: s.target.y || 0, z: s.target.z || 0 };
    if (s.fovDegrees != null) this.setFOV(s.fovDegrees);
    if (s.ortho3D != null) this.setOrtho3D(s.ortho3D);
    // Override radius again after setFOV (which adjusts radius for compensation)
    if (s.radius != null) this._orbitRadius = _clampOrbitRadius(s.radius);
    this._orbitDirty = true;
  }

  /**
   * Pick an origin plane by raycasting from screen coordinates.
   * Tests the XY, XZ, YZ planes (5×5 unit squares at origin) and returns
   * the closest hit plane name, or null if none hit.
   * @param {number} screenX - client X
   * @param {number} screenY - client Y
   * @returns {string|null} 'XY', 'XZ', 'YZ', or null
   */
  pickPlane(screenX, screenY) {
    const ray = this._computePickRay(screenX, screenY);
    if (!ray) return null;
    const { origin, dir } = ray;

    const planeSize = 5.0;
    const planes = [
      { name: 'XY', normal: { x: 0, y: 0, z: 1 }, uAxis: 'x', vAxis: 'y', constAxis: 'z', constVal: 0 },
      { name: 'XZ', normal: { x: 0, y: 1, z: 0 }, uAxis: 'x', vAxis: 'z', constAxis: 'y', constVal: 0 },
      { name: 'YZ', normal: { x: 1, y: 0, z: 0 }, uAxis: 'y', vAxis: 'z', constAxis: 'x', constVal: 0 },
    ];

    let closestT = Infinity;
    let closestPlane = null;

    for (const p of planes) {
      const planeMask = p.name === 'XY' ? 1 : (p.name === 'XZ' ? 2 : 4);
      if ((this._originPlaneVisibilityMask & planeMask) === 0) continue;

      const denom = dir.x * p.normal.x + dir.y * p.normal.y + dir.z * p.normal.z;
      if (Math.abs(denom) < 1e-10) continue;

      const diff = { x: -origin.x, y: -origin.y, z: -origin.z };
      diff[p.constAxis] = p.constVal - origin[p.constAxis];
      const t = (diff.x * p.normal.x + diff.y * p.normal.y + diff.z * p.normal.z) / denom;
      if (t < 0) continue;

      const hit = {
        x: origin.x + dir.x * t,
        y: origin.y + dir.y * t,
        z: origin.z + dir.z * t,
      };

      // Check if hit point is within the plane quad
      if (Math.abs(hit[p.uAxis]) <= planeSize && Math.abs(hit[p.vAxis]) <= planeSize) {
        if (t < closestT) {
          closestT = t;
          closestPlane = { name: p.name, point: hit };
        }
      }
    }

    return closestPlane;
  }

  /**
   * Set hovered plane highlight in WASM renderer.
   * @param {string|null} planeName - 'XY', 'XZ', 'YZ', or null
   */
  setHoveredPlane(planeName) {
    if (!this._ready || !this.wasm || !this.wasm.setOriginPlaneHovered) return;
    let mask = 0;
    if (planeName === 'XY') mask = 1;
    else if (planeName === 'XZ') mask = 2;
    else if (planeName === 'YZ') mask = 4;
    if ((mask & this._originPlaneVisibilityMask) === 0) mask = 0;
    this.wasm.setOriginPlaneHovered(mask);
  }

  /**
   * Set selected plane highlight in WASM renderer.
   * @param {string|null} planeName - 'XY', 'XZ', 'YZ', or null
   */
  setSelectedPlane(planeName) {
    if (!this._ready || !this.wasm || !this.wasm.setOriginPlaneSelected) return;
    let mask = 0;
    if (planeName === 'XY') mask = 1;
    else if (planeName === 'XZ') mask = 2;
    else if (planeName === 'YZ') mask = 4;
    if ((mask & this._originPlaneVisibilityMask) === 0) mask = 0;
    this.wasm.setOriginPlaneSelected(mask);
  }

  /**
   * Set the selected feature ID for highlighting in the 3D view.
   * When a sketch is selected, its wireframes are highlighted.
   * @param {string|null} featureId - Feature ID or null to clear selection
   */
  setSelectedFeature(featureId) {
    this._selectedFeatureId = featureId || null;
    if (this._renderedPart) {
      this._buildSketchWireframes(this._renderedPart);
    }
  }

  _sketchWireHashValue(hash, value) {
    const normalized = Number.isFinite(value) ? Math.round(value * 1e6) : 0;
    return Math.imul((hash ^ normalized) >>> 0, 16777619) >>> 0;
  }

  _sketchWireHashText(hash, value) {
    const text = String(value ?? '');
    for (let i = 0; i < text.length; i++) {
      hash = Math.imul((hash ^ text.charCodeAt(i)) >>> 0, 16777619) >>> 0;
    }
    return hash >>> 0;
  }

  _sketchWireSignature(sketchFeature, sketch, plane) {
    let hash = 2166136261;
    hash = this._sketchWireHashText(hash, sketchFeature?.id || '');
    for (const vector of [plane?.origin, plane?.xAxis, plane?.yAxis, plane?.normal]) {
      hash = this._sketchWireHashValue(hash, vector?.x);
      hash = this._sketchWireHashValue(hash, vector?.y);
      hash = this._sketchWireHashValue(hash, vector?.z);
    }

    const hashPoint = (point) => {
      hash = this._sketchWireHashValue(hash, point?.x);
      hash = this._sketchWireHashValue(hash, point?.y);
    };
    const hashHandle = (handle) => {
      hash = this._sketchWireHashValue(hash, handle?.dx);
      hash = this._sketchWireHashValue(hash, handle?.dy);
    };
    const hashEntity = (entity) => {
      hash = this._sketchWireHashText(hash, entity?.id || entity?.type || '');
      hash = this._sketchWireHashValue(hash, entity?.visible === false ? 0 : 1);
      hash = this._sketchWireHashValue(hash, entity?.construction ? 1 : 0);
      hash = this._sketchWireHashText(hash, entity?.layer || '');
    };

    for (const seg of sketch?.segments || []) {
      hashEntity(seg);
      hashPoint(seg?.p1);
      hashPoint(seg?.p2);
    }
    for (const circle of sketch?.circles || []) {
      hashEntity(circle);
      hashPoint(circle?.center);
      hash = this._sketchWireHashValue(hash, circle?.radius);
    }
    for (const arc of sketch?.arcs || []) {
      hashEntity(arc);
      hashPoint(arc?.center);
      hash = this._sketchWireHashValue(hash, arc?.radius);
      hash = this._sketchWireHashValue(hash, arc?.startAngle);
      hash = this._sketchWireHashValue(hash, arc?.endAngle);
    }
    for (const spl of sketch?.splines || []) {
      hashEntity(spl);
      for (const point of spl?.points || []) hashPoint(point);
    }
    for (const bez of sketch?.beziers || []) {
      hashEntity(bez);
      for (const vertex of bez?.vertices || []) {
        hashPoint(vertex?.point);
        hashHandle(vertex?.handleIn);
        hashHandle(vertex?.handleOut);
        hash = this._sketchWireHashValue(hash, vertex?.tangent === false ? 0 : 1);
      }
    }
    return hash.toString(16);
  }

  _getSketchWireframeCacheEntry(sketchFeature, sketch, plane, toWorld, nx, ny, nz) {
    const featureId = sketchFeature?.id || '__unknown__';
    const signature = this._sketchWireSignature(sketchFeature, sketch, plane);
    const cached = this._sketchWireframeCache.get(featureId);
    if (cached?.signature === signature) return cached;

    const lineVertices = [];
    const pickSegments = [];
    const faceVertices = [];
    const pickTriangles = [];

    const appendLine = (a, b) => {
      lineVertices.push(a.x, a.y, a.z, b.x, b.y, b.z);
      pickSegments.push({ a, b });
    };

    for (const seg of sketch?.segments || []) {
      if (!seg.visible || seg.construction || !seg.p1 || !seg.p2) continue;
      appendLine(toWorld(seg.p1.x, seg.p1.y), toWorld(seg.p2.x, seg.p2.y));
    }

    for (const circle of sketch?.circles || []) {
      if (!circle.visible || !circle.center) continue;
      const numSegs = 32;
      for (let i = 0; i < numSegs; i++) {
        const a1 = (i / numSegs) * Math.PI * 2;
        const a2 = ((i + 1) / numSegs) * Math.PI * 2;
        appendLine(
          toWorld(circle.center.x + Math.cos(a1) * circle.radius, circle.center.y + Math.sin(a1) * circle.radius),
          toWorld(circle.center.x + Math.cos(a2) * circle.radius, circle.center.y + Math.sin(a2) * circle.radius),
        );
      }
    }

    for (const arc of sketch?.arcs || []) {
      if (!arc.visible || !arc.center) continue;
      const numSegs = 16;
      const startA = arc.startAngle || 0;
      const endA = arc.endAngle || Math.PI;
      let sweep = endA - startA;
      if (sweep < 0) sweep += Math.PI * 2;
      for (let i = 0; i < numSegs; i++) {
        const a1 = startA + (i / numSegs) * sweep;
        const a2 = startA + ((i + 1) / numSegs) * sweep;
        appendLine(
          toWorld(arc.center.x + Math.cos(a1) * arc.radius, arc.center.y + Math.sin(a1) * arc.radius),
          toWorld(arc.center.x + Math.cos(a2) * arc.radius, arc.center.y + Math.sin(a2) * arc.radius),
        );
      }
    }

    for (const spl of sketch?.splines || []) {
      if (!spl.visible || spl.construction || !spl.p1 || !spl.p2) continue;
      const pts = spl.tessellate2D(32);
      for (let i = 0; i < pts.length - 1; i++) {
        appendLine(toWorld(pts[i].x, pts[i].y), toWorld(pts[i + 1].x, pts[i + 1].y));
      }
    }

    for (const bez of sketch?.beziers || []) {
      if (!bez.visible || bez.construction || !bez.p1 || !bez.p2) continue;
      const pts = bez.tessellate2D(16);
      for (let i = 0; i < pts.length - 1; i++) {
        appendLine(toWorld(pts[i].x, pts[i].y), toWorld(pts[i + 1].x, pts[i + 1].y));
      }
    }

    const profiles = Array.isArray(sketchFeature?.result?.profiles)
      ? sketchFeature.result.profiles
      : extractRenderableSketchProfiles(sketch?.scene || sketch);
    for (const tri of triangulateSketchProfileFill(profiles)) {
      const a2 = tri[0];
      const b2 = tri[1];
      const c2 = tri[2];
      const a = toWorld(a2.x, a2.y);
      const b = toWorld(b2.x, b2.y);
      const c = toWorld(c2.x, c2.y);
      faceVertices.push(a.x, a.y, a.z, nx, ny, nz);
      faceVertices.push(b.x, b.y, b.z, nx, ny, nz);
      faceVertices.push(c.x, c.y, c.z, nx, ny, nz);
      pickTriangles.push([a, b, c]);
    }

    const entry = { signature, lineVertices, pickSegments, faceVertices, pickTriangles };
    this._sketchWireframeCache.set(featureId, entry);
    return entry;
  }

  _appendSketchWireArray(target, source) {
    for (let i = 0; i < source.length; i++) target.push(source[i]);
  }

  /**
   * Cast a ray from screen coordinates onto a plane in 3D world space.
   * Returns the 2D coordinates in the plane's local frame (xAxis, yAxis).
   * @param {number} screenX - screen X (relative to canvas left)
   * @param {number} screenY - screen Y (relative to canvas top)
   * @param {Object} planeDef - { origin, normal, xAxis, yAxis }
   * @returns {{x: number, y: number}|null} 2D coords on the plane, or null if ray is parallel
   */
  rayToPlane(screenX, screenY, planeDef) {
    const mvp = this._computeMVP();
    if (!mvp) return null;

    const invMVP = this._mat4Invert(mvp);
    if (!invMVP) return null;

    const rect = this.canvas.getBoundingClientRect();
    const ndcX = (screenX / rect.width) * 2 - 1;
    const ndcY = -(screenY / rect.height) * 2 + 1;

    // Near point (NDC z = -1) and far point (NDC z = 1)
    const nearW = this._mat4TransformVec4(invMVP, ndcX, ndcY, -1, 1);
    const farW = this._mat4TransformVec4(invMVP, ndcX, ndcY, 1, 1);
    if (Math.abs(nearW.w) < 1e-10 || Math.abs(farW.w) < 1e-10) return null;

    const origin = { x: nearW.x / nearW.w, y: nearW.y / nearW.w, z: nearW.z / nearW.w };
    const farPt = { x: farW.x / farW.w, y: farW.y / farW.w, z: farW.z / farW.w };
    const dir = {
      x: farPt.x - origin.x,
      y: farPt.y - origin.y,
      z: farPt.z - origin.z,
    };

    // Ray-plane intersection: t = dot(planeOrigin - origin, normal) / dot(dir, normal)
    const n = planeDef.normal;
    const o = planeDef.origin;
    const denom = dir.x * n.x + dir.y * n.y + dir.z * n.z;
    if (Math.abs(denom) < 1e-10) return null; // ray parallel to plane

    const diff = { x: o.x - origin.x, y: o.y - origin.y, z: o.z - origin.z };
    const t = (diff.x * n.x + diff.y * n.y + diff.z * n.z) / denom;

    // 3D intersection point on the plane
    const hit = {
      x: origin.x + dir.x * t,
      y: origin.y + dir.y * t,
      z: origin.z + dir.z * t,
    };

    // Project onto the plane's local 2D coordinate system
    const local = { x: hit.x - o.x, y: hit.y - o.y, z: hit.z - o.z };
    const ax = planeDef.xAxis;
    const ay = planeDef.yAxis;
    return {
      x: local.x * ax.x + local.y * ax.y + local.z * ax.z,
      y: local.x * ay.x + local.y * ay.y + local.z * ay.z,
    };
  }

  /** Möller–Trumbore ray-triangle intersection */
  _rayTriangleIntersect(origin, dir, v0, v1, v2) {
    const EPSILON = 1e-8;
    const e1 = { x: v1.x - v0.x, y: v1.y - v0.y, z: v1.z - v0.z };
    const e2 = { x: v2.x - v0.x, y: v2.y - v0.y, z: v2.z - v0.z };
    const h = {
      x: dir.y * e2.z - dir.z * e2.y,
      y: dir.z * e2.x - dir.x * e2.z,
      z: dir.x * e2.y - dir.y * e2.x,
    };
    const a = e1.x * h.x + e1.y * h.y + e1.z * h.z;
    if (a > -EPSILON && a < EPSILON) return null;
    const f = 1.0 / a;
    const s = { x: origin.x - v0.x, y: origin.y - v0.y, z: origin.z - v0.z };
    const u = f * (s.x * h.x + s.y * h.y + s.z * h.z);
    if (u < 0 || u > 1) return null;
    const q = {
      x: s.y * e1.z - s.z * e1.y,
      y: s.z * e1.x - s.x * e1.z,
      z: s.x * e1.y - s.y * e1.x,
    };
    const v = f * (dir.x * q.x + dir.y * q.y + dir.z * q.z);
    if (v < 0 || u + v > 1) return null;
    const t = f * (e2.x * q.x + e2.y * q.y + e2.z * q.z);
    return t > EPSILON ? t : null;
  }

  /** Invert a 4x4 column-major matrix */
  _mat4Invert(m) {
    const out = new Float32Array(16);
    const m00 = m[0], m01 = m[1], m02 = m[2], m03 = m[3];
    const m10 = m[4], m11 = m[5], m12 = m[6], m13 = m[7];
    const m20 = m[8], m21 = m[9], m22 = m[10], m23 = m[11];
    const m30 = m[12], m31 = m[13], m32 = m[14], m33 = m[15];

    const b00 = m00 * m11 - m01 * m10;
    const b01 = m00 * m12 - m02 * m10;
    const b02 = m00 * m13 - m03 * m10;
    const b03 = m01 * m12 - m02 * m11;
    const b04 = m01 * m13 - m03 * m11;
    const b05 = m02 * m13 - m03 * m12;
    const b06 = m20 * m31 - m21 * m30;
    const b07 = m20 * m32 - m22 * m30;
    const b08 = m20 * m33 - m23 * m30;
    const b09 = m21 * m32 - m22 * m31;
    const b10 = m21 * m33 - m23 * m31;
    const b11 = m22 * m33 - m23 * m32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (Math.abs(det) < 1e-10) return null;
    det = 1.0 / det;

    out[0]  = ( m11 * b11 - m12 * b10 + m13 * b09) * det;
    out[1]  = (-m01 * b11 + m02 * b10 - m03 * b09) * det;
    out[2]  = ( m31 * b05 - m32 * b04 + m33 * b03) * det;
    out[3]  = (-m21 * b05 + m22 * b04 - m23 * b03) * det;
    out[4]  = (-m10 * b11 + m12 * b08 - m13 * b07) * det;
    out[5]  = ( m00 * b11 - m02 * b08 + m03 * b07) * det;
    out[6]  = (-m30 * b05 + m32 * b02 - m33 * b01) * det;
    out[7]  = ( m20 * b05 - m22 * b02 + m23 * b01) * det;
    out[8]  = ( m10 * b10 - m11 * b08 + m13 * b06) * det;
    out[9]  = (-m00 * b10 + m01 * b08 - m03 * b06) * det;
    out[10] = ( m30 * b04 - m31 * b02 + m33 * b00) * det;
    out[11] = (-m20 * b04 + m21 * b02 - m23 * b00) * det;
    out[12] = (-m10 * b09 + m11 * b07 - m12 * b06) * det;
    out[13] = ( m00 * b09 - m01 * b07 + m02 * b06) * det;
    out[14] = (-m30 * b03 + m31 * b01 - m32 * b00) * det;
    out[15] = ( m20 * b03 - m21 * b01 + m22 * b00) * det;
    return out;
  }

  /** Transform a vec4 by a 4x4 column-major matrix */
  _mat4TransformVec4(m, x, y, z, w) {
    return {
      x: m[0] * x + m[4] * y + m[8]  * z + m[12] * w,
      y: m[1] * x + m[5] * y + m[9]  * z + m[13] * w,
      z: m[2] * x + m[6] * y + m[10] * z + m[14] * w,
      w: m[3] * x + m[7] * y + m[11] * z + m[15] * w,
    };
  }

  /* ---------- mode switching ---------- */
  setMode(mode) {
    this.mode = mode;
    if (!this._ready) return;

    if (mode === '2d') {
      this.wasm.setCameraMode(0);
      // Reset ortho
      const w = this.canvas.width;
      const h = this.canvas.height;
      const aspect = w / h;
      const viewSize = 500;
      this._orthoBounds = {
        left: -viewSize * aspect,
        right: viewSize * aspect,
        bottom: -viewSize,
        top: viewSize,
      };
      this.wasm.setOrthoBounds(
        this._orthoBounds.left, this._orthoBounds.right,
        this._orthoBounds.bottom, this._orthoBounds.top
      );
      this.wasm.setCameraPosition(0, 0, 500);
      this.wasm.setCameraTarget(0, 0, 0);
      // Up must be (0,1,0) when looking down the Z axis to avoid
      // a degenerate lookAt matrix (up parallel to view direction).
      this.wasm.setCameraUp(0, 1, 0);
      this.wasm.setGridVisible(this._gridVisible ? 1 : 0);
      this.wasm.setAxesVisible(this._axesVisible ? 1 : 0);
    } else {
      this.wasm.setCameraMode(1);
      // Restore Z-up for 3D orbit camera
      this.wasm.setCameraUp(0, 0, 1);
      // Set a reasonable default grid for 3D mode
      this.wasm.setGridSize(200, 20);
      this.wasm.setAxesSize(50);
      // Clear stale 2D entities so they don't render in pure 3D mode
      this.wasm.clearEntities();
      this.wasm.resetEntityModelMatrix();
      // Apply orbit camera state
      this._orbitDirty = true;
      this._applyOrbitCamera();
      this.wasm.setGridVisible(this._gridVisible ? 1 : 0);
      this.wasm.setAxesVisible(this._axesVisible ? 1 : 0);
    }
  }

  setGridVisible(visible) {
    this._gridVisible = visible !== false;
    if (this._ready && this.wasm && this.wasm.setGridVisible) {
      this.wasm.setGridVisible(this._gridVisible ? 1 : 0);
    }
  }

  setAxesVisible(visible) {
    this._axesVisible = visible !== false;
    if (this._ready && this.wasm && this.wasm.setAxesVisible) {
      this.wasm.setAxesVisible(this._axesVisible ? 1 : 0);
    }
  }

  setVisible(visible) {
    this.canvas.style.display = visible ? 'block' : 'none';
    this.overlayCanvas.style.display = visible ? 'block' : 'none';
  }

  /**
   * Clear the overlay canvas (removes stale 2D text/axis overlays).
   */
  clearOverlay() {
    const w = this._cssWidth || this.container.clientWidth;
    const h = this._cssHeight || this.container.clientHeight;
    this.overlayCtx.clearRect(0, 0, w, h);
  }

  onWindowResize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w <= 0 || h <= 0) return;

    const dpr = window.devicePixelRatio || 1;

    this.canvas.width = w;
    this.canvas.height = h;

    // DPR-scale overlay canvas for crisp text on HiDPI displays
    this.overlayCanvas.width = Math.round(w * dpr);
    this.overlayCanvas.height = Math.round(h * dpr);
    this.overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Store CSS pixel dimensions for coordinate mapping
    this._cssWidth = w;
    this._cssHeight = h;

    this.executor.resize(w, h);

    if (this._ready) {
      this.wasm.resize(w, h);
    }
  }

  /* ---------- 2D Sketch Rendering ---------- */

  /**
   * Sync orthographic camera to viewport pan/zoom.
   */
  sync2DView(viewport) {
    if (!viewport || !this._ready || this.mode !== '2d') return;

    const zoom = Math.max(0.0001, viewport.zoom || 1);
    const w = Math.max(1, viewport.width || this.canvas.width);
    const h = Math.max(1, viewport.height || this.canvas.height);

    const halfW = w / (2 * zoom);
    const halfH = h / (2 * zoom);

    const cx = -viewport.panX / zoom;
    const cy = viewport.panY / zoom;

    this._orthoBounds = { left: cx - halfW, right: cx + halfW, bottom: cy - halfH, top: cy + halfH };
    this._cameraPos = { x: cx, y: cy, z: 500 };

    this.wasm.setOrthoBounds(cx - halfW, cx + halfW, cy - halfH, cy + halfH);
    this.wasm.setCameraPosition(cx, cy, 500);
    this.wasm.setCameraTarget(cx, cy, 0);
    // Ensure up vector stays Y-up for 2D top-down view
    this.wasm.setCameraUp(0, 1, 0);
  }

  /**
   * Render 2D sketch entities.
   * Pushes entity data to WASM for GPU-accelerated rendering.
   * Text/dimension labels and constraint icons remain on the overlay canvas
   * since WebGL does not natively support text.
   */
  render2DScene(scene, overlays = {}) {
    if (!scene || !this._ready) return;
    this._last2DScene = scene;
    this._last2DOverlays = overlays;

    const wasm = this.wasm;
    wasm.clearEntities();

    // Set up entity model matrix for the sketch plane
    const pd = this._sketchPlaneDef;
    if (this.mode === '3d' && pd && wasm.setEntityModelMatrix) {
      // Build column-major 4x4 matrix that transforms local (x, y, 0) to world.
      // Add a small offset along the plane normal to prevent z-fighting when
      // the sketch plane coincides with a feature face.
      const SKETCH_Z_OFFSET = 0.02;
      const ox = pd.origin.x + pd.normal.x * SKETCH_Z_OFFSET;
      const oy = pd.origin.y + pd.normal.y * SKETCH_Z_OFFSET;
      const oz = pd.origin.z + pd.normal.z * SKETCH_Z_OFFSET;
      // Column 0: xAxis, Column 1: yAxis, Column 2: normal (z), Column 3: origin (translation)
      wasm.setEntityModelMatrix(
        pd.xAxis.x, pd.xAxis.y, pd.xAxis.z, 0,
        pd.yAxis.x, pd.yAxis.y, pd.yAxis.z, 0,
        pd.normal.x, pd.normal.y, pd.normal.z, 0,
        ox, oy, oz, 1
      );
    } else if (wasm.resetEntityModelMatrix) {
      wasm.resetEntityModelMatrix();
    }

    // Build active sketch wireframe data for re-rendering on top of mesh overlay.
    // When sketching on a face, WASM draws 2D entities first, then the mesh overlay
    // covers them. We capture the wireframe here so _renderMeshOverlay can re-draw
    // the sketch entities on top with depth test disabled.
    // Include preview entities (lines being drawn but not yet committed) so they
    // are also visible on top of the mesh during interactive drawing.
    if (this.mode === '3d' && pd && this._sketchPlane) {
      this._buildActiveSceneWireframes(scene, pd, overlays.previewEntities);
    } else {
      this._activeSceneEdges = null;
      this._activeSceneEdgeVertexCount = 0;
    }

    const isLayerVisible = overlays.isLayerVisible || (() => true);
    const getLayerColor = overlays.getLayerColor || (() => '#9CDCFE');
    const hoverEntity = overlays.hoverEntity || null;
    const previewEntities = overlays.previewEntities || [];
    const snapPoint = overlays.snapPoint || null;
    const cursorWorld = overlays.cursorWorld || null;
    const allDimensionsVisible = overlays.allDimensionsVisible !== false;
    const constraintIconsVisible = overlays.constraintIconsVisible !== false;
    const activeTool = overlays.activeTool || null;

    // Transform local sketch coordinates to world (for 3D sketch on non-XY planes).
    // For the XY plane or 2D mode, this is identity.
    const useSketchTransform = this.mode === '3d' && pd;
    const localToWorld = useSketchTransform
      ? (lx, ly) => ({
          x: pd.origin.x + lx * pd.xAxis.x + ly * pd.yAxis.x,
          y: pd.origin.y + lx * pd.xAxis.y + ly * pd.yAxis.y,
          z: pd.origin.z + lx * pd.xAxis.z + ly * pd.yAxis.z,
        })
      : (lx, ly) => ({ x: lx, y: ly, z: 0 });

    // Entity flag constants
    const F_VISIBLE = 1;
    const F_SELECTED = 2;
    const F_CONSTRUCTION = 4;
    const F_HOVER = 8;
    const F_FIXED = 16;
    const F_PREVIEW = 32;

    const DEFAULT_COLOR = [0.612, 0.863, 0.996, 1.0]; // #9CDCFE

    const parseColor = (colorStr) => {
      if (!colorStr || typeof colorStr !== 'string') return DEFAULT_COLOR;
      if (colorStr.startsWith('#')) {
        const hex = colorStr.slice(1);
        if (hex.length === 6) {
          return [
            parseInt(hex.slice(0, 2), 16) / 255,
            parseInt(hex.slice(2, 4), 16) / 255,
            parseInt(hex.slice(4, 6), 16) / 255,
            1.0
          ];
        }
      }
      return DEFAULT_COLOR;
    };

    // Compute fully-constrained sets for this frame
    const fc = _computeFullyConstrained(scene);

    const entityColor = (entity) => {
      if (entity.selected) return [0, 0.749, 1, 1];
      if (entity.construction) return [0.565, 0.933, 0.565, 1];
      if (fc.entities.has(entity)) return FULLY_CONSTRAINED_COLOR;
      const c = entity.color || getLayerColor(entity.layer);
      return parseColor(c);
    };

    // --- Push segments to WASM ---
    if (scene.segments) {
      scene.segments.forEach((seg) => {
        if (!seg.visible || !isLayerVisible(seg.layer) || !seg.p1 || !seg.p2) return;
        let flags = F_VISIBLE;
        if (seg.selected) flags |= F_SELECTED;
        if (seg.construction) flags |= F_CONSTRUCTION;
        if (hoverEntity && hoverEntity.id === seg.id) flags |= F_HOVER;
        const [r, g, b, a] = entityColor(seg);
        wasm.addEntitySegment(seg.p1.x, seg.p1.y, seg.p2.x, seg.p2.y, flags, r, g, b, a);
      });
    }

    // --- Push circles to WASM ---
    if (scene.circles) {
      scene.circles.forEach((circle) => {
        if (!circle.visible || !isLayerVisible(circle.layer)) return;
        let flags = F_VISIBLE;
        if (circle.selected) flags |= F_SELECTED;
        if (circle.construction) flags |= F_CONSTRUCTION;
        if (hoverEntity && hoverEntity.id === circle.id) flags |= F_HOVER;
        const [r, g, b, a] = entityColor(circle);
        wasm.addEntityCircle(circle.center.x, circle.center.y, circle.radius, flags, r, g, b, a);
      });
    }

    // --- Push arcs to WASM ---
    if (scene.arcs) {
      scene.arcs.forEach((arc) => {
        if (!arc.visible || !isLayerVisible(arc.layer)) return;
        let flags = F_VISIBLE;
        if (arc.selected) flags |= F_SELECTED;
        if (arc.construction) flags |= F_CONSTRUCTION;
        if (hoverEntity && hoverEntity.id === arc.id) flags |= F_HOVER;
        const [r, g, b, a] = entityColor(arc);
        wasm.addEntityArc(arc.center.x, arc.center.y, arc.radius, arc.startAngle, arc.endAngle, flags, r, g, b, a);
      });
    }

    // --- Push splines to WASM (tessellated as line segments) ---
    if (scene.splines) {
      scene.splines.forEach((spl) => {
        if (!spl.visible || !isLayerVisible(spl.layer)) return;
        let flags = F_VISIBLE;
        if (spl.selected) flags |= F_SELECTED;
        if (spl.construction) flags |= F_CONSTRUCTION;
        if (hoverEntity && hoverEntity.id === spl.id) flags |= F_HOVER;
        const [r, g, b, a] = entityColor(spl);
        const pts = spl.tessellate2D(32);
        for (let i = 0; i < pts.length - 1; i++) {
          wasm.addEntitySegment(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, flags, r, g, b, a);
        }
      });
    }

    // --- Push beziers to WASM (tessellated as line segments) ---
    if (scene.beziers) {
      scene.beziers.forEach((bez) => {
        if (!bez.visible || !isLayerVisible(bez.layer)) return;
        let flags = F_VISIBLE;
        if (bez.selected) flags |= F_SELECTED;
        if (bez.construction) flags |= F_CONSTRUCTION;
        if (hoverEntity && hoverEntity.id === bez.id) flags |= F_HOVER;
        const [r, g, b, a] = entityColor(bez);
        const pts = bez.tessellate2D(16);
        for (let i = 0; i < pts.length - 1; i++) {
          wasm.addEntitySegment(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, flags, r, g, b, a);
        }
      });
    }

    // --- Push points to WASM ---
    if (scene.points) {
      // Pre-compute point reference counts in one pass to avoid O(points × entities)
      const ptRefs = new Map();
      for (const s of scene.segments) { ptRefs.set(s.p1, (ptRefs.get(s.p1) || 0) + 1); ptRefs.set(s.p2, (ptRefs.get(s.p2) || 0) + 1); }
      for (const c of scene.circles) { ptRefs.set(c.center, (ptRefs.get(c.center) || 0) + 1); }
      for (const a of scene.arcs) { ptRefs.set(a.center, (ptRefs.get(a.center) || 0) + 1); }
      for (const spl of scene.splines) { for (const p of spl.points) ptRefs.set(p, (ptRefs.get(p) || 0) + 1); }
      if (scene.beziers) { for (const bez of scene.beziers) { for (const p of bez.points) ptRefs.set(p, (ptRefs.get(p) || 0) + 1); } }

      scene.points.forEach((point) => {
        const refs = ptRefs.get(point) || 0;
        const isHover = hoverEntity && hoverEntity.id === point.id;
        const isFCPt = fc.points.has(point);
        // Show points that are: referenced by 2+ entities (junction), selected, fixed,
        // hovered, or fully constrained. Also always show spline/bezier endpoints
        // (p1/p2) so the user can see and drag them.
        if (refs < 1 && !point.selected && !point.fixed && !isHover && !isFCPt) return;
        // For single-reference points, only show if they are spline/bezier endpoints
        // (interior control points stay hidden until the spline is selected)
        if (refs === 1 && !point.selected && !point.fixed && !isHover && !isFCPt) {
          let isEndpoint = false;
          for (const spl of scene.splines) {
            if (spl.p1 === point || spl.p2 === point) { isEndpoint = true; break; }
          }
          if (!isEndpoint && scene.beziers) {
            for (const bez of scene.beziers) {
              if (bez.p1 === point || bez.p2 === point) { isEndpoint = true; break; }
            }
          }
          if (!isEndpoint) return;
        }
        let flags = F_VISIBLE;
        if (point.selected) flags |= F_SELECTED;
        if (isHover) flags |= F_HOVER;
        if (point.fixed) flags |= F_FIXED;
        const size = point.selected ? 7 : (isHover ? 6 : ((point.fixed || isFCPt) ? 5 : 4));
        const [r, g, b, a] = point.selected ? [0, 0.749, 1, 1]
          : (isHover ? [0.498, 0.847, 1, 1]
            : isFCPt ? FULLY_CONSTRAINED_COLOR
            : (point.fixed ? [1, 0.4, 0.267, 1]
              : [1, 1, 0.4, 1]));
        wasm.addEntityPoint(point.x, point.y, size, flags, r, g, b, a);
      });
    }

    // --- Push dimensions to WASM (line geometry: extension + dimension lines + arrowheads) ---
    if (allDimensionsVisible && scene.dimensions && wasm.addEntityDimension) {
      // Dimension type constants (must match DIM_* in entities.ts)
      const DIM_LINEAR = 0;
      const DIM_HORIZONTAL = 1;
      const DIM_VERTICAL = 2;
      const DIM_ANGLE = 3;

      scene.dimensions.forEach((dim) => {
        if (!dim.visible || !isLayerVisible(dim.layer)) return;
        let flags = F_VISIBLE;
        if (dim.selected) flags |= F_SELECTED;
        if (hoverEntity && hoverEntity.id === dim.id) flags |= F_HOVER;

        const dimColor = dim.selected ? [0, 0.749, 1, 1]
          : (hoverEntity && hoverEntity.id === dim.id ? [0.498, 0.847, 1, 1]
            : (!dim.isConstraint ? [1, 0.706, 0.196, 1]
              : parseColor(dim.color || getLayerColor(dim.layer))));
        const [r, g, b, a] = dimColor;

        let dimType = DIM_LINEAR;
        if (dim.dimType === 'dx') dimType = DIM_HORIZONTAL;
        else if (dim.dimType === 'dy') dimType = DIM_VERTICAL;
        else if (dim.dimType === 'angle') dimType = DIM_ANGLE;

        const angleStart = dim._angleStart != null ? dim._angleStart : 0;
        const angleSweep = dim._angleSweep != null ? dim._angleSweep : 0;

        wasm.addEntityDimension(
          dim.x1, dim.y1, dim.x2, dim.y2,
          dim.offset || 20, dimType,
          angleStart, angleSweep,
          flags, r, g, b, a
        );
      });
    }

    // --- Push preview entities to WASM ---
    if (previewEntities && previewEntities.length > 0) {
      previewEntities.forEach((entity) => {
        if (!entity) return;
        const flags = F_VISIBLE | F_PREVIEW;
        const [r, g, b, a] = parseColor(entity.color || '#ffcc33');
        if (entity.type === 'segment' && entity.p1 && entity.p2) {
          wasm.addEntitySegment(entity.p1.x, entity.p1.y, entity.p2.x, entity.p2.y, flags, r, g, b, a);
        } else if (entity.type === 'circle' && entity.center) {
          wasm.addEntityCircle(entity.center.x, entity.center.y, entity.radius, flags, r, g, b, a);
        } else if (entity.type === 'arc' && entity.center) {
          wasm.addEntityArc(entity.center.x, entity.center.y, entity.radius, entity.startAngle, entity.endAngle, flags, r, g, b, a);
        } else if (entity.type === 'spline' && entity.points && entity.points.length >= 2) {
          // Tessellate spline into line segments for WASM rendering
          const pts = entity.tessellate2D(32);
          for (let i = 0; i < pts.length - 1; i++) {
            wasm.addEntitySegment(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, flags, r, g, b, a);
          }
        } else if (entity.type === 'bezier' && entity.vertices && entity.vertices.length >= 2) {
          // Tessellate bezier into line segments for WASM rendering
          const pts = entity.tessellate2D(16);
          for (let i = 0; i < pts.length - 1; i++) {
            wasm.addEntitySegment(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, flags, r, g, b, a);
          }
        } else if (entity.type === 'dimension' && wasm.addEntityDimension) {
          const DIM_LINEAR = 0, DIM_HORIZONTAL = 1, DIM_VERTICAL = 2, DIM_ANGLE = 3;
          let dimType = DIM_LINEAR;
          if (entity.dimType === 'dx') dimType = DIM_HORIZONTAL;
          else if (entity.dimType === 'dy') dimType = DIM_VERTICAL;
          else if (entity.dimType === 'angle') dimType = DIM_ANGLE;
          const angleStart = entity._angleStart != null ? entity._angleStart : 0;
          const angleSweep = entity._angleSweep != null ? entity._angleSweep : 0;
          wasm.addEntityDimension(
            entity.x1, entity.y1, entity.x2, entity.y2,
            entity.offset || 20, dimType,
            angleStart, angleSweep,
            flags, 0, 0.749, 1, 0.7
          );
        }
      });
    }

    // --- Snap point ---
    if (snapPoint) {
      wasm.setSnapPosition(snapPoint.x, snapPoint.y, 1);
    } else {
      wasm.setSnapPosition(0, 0, 0);
    }

    // --- Cursor crosshair ---
    if (cursorWorld && (this.mode === '2d' || this._sketchPlane)) {
      wasm.setCursorPosition(cursorWorld.x, cursorWorld.y, 1);
    } else {
      wasm.setCursorPosition(0, 0, 0);
    }

    // --- Overlay canvas for text-based elements (dimensions, constraint icons) ---
    const ctx = this.overlayCtx;
    // Use CSS pixel dimensions for coordinate mapping (overlay canvas is DPR-scaled via setTransform)
    const w = this._cssWidth || this.container.clientWidth;
    const h = this._cssHeight || this.container.clientHeight;
    ctx.clearRect(0, 0, w, h);

    // Choose world-to-screen transform: in 3D sketch mode, use MVP projection;
    // otherwise use the orthographic bounds.
    const in3DSketch = this.mode === '3d' && this._sketchPlaneDef;
    let worldToScreenX, worldToScreenY, wpp;
    if (in3DSketch) {
      worldToScreenX = (wx) => {
        const s = this.sketchToScreen(wx, 0);
        return s ? s.x : 0;
      };
      worldToScreenY = (wy) => {
        const s = this.sketchToScreen(0, wy);
        return s ? s.y : 0;
      };
      // For 3D sketch, approximate wpp (world per pixel) from orbit radius
      wpp = (this._orbitRadius || 100) / Math.max(w, 1);
    } else {
      const bounds = this._orthoBounds;
      worldToScreenX = (wx) => ((wx - bounds.left) / (bounds.right - bounds.left)) * w;
      worldToScreenY = (wy) => ((bounds.top - wy) / (bounds.top - bounds.bottom)) * h;
      wpp = (bounds.right - bounds.left) / w;
    }
    // Helper: project a local 2D point (x,y) in the sketch plane to screen
    const sketchPtToScreen = in3DSketch
      ? (lx, ly) => this.sketchToScreen(lx, ly) || { x: 0, y: 0 }
      : (lx, ly) => ({ x: worldToScreenX(lx), y: worldToScreenY(ly) });

    this._renderSceneImageOverlay(ctx, scene, {
      isLayerVisible,
      sketchPtToScreen,
      selectedEntityIds: new Set((scene.images || []).filter((image) => image.selected).map((image) => image.id)),
      hoverEntity,
    });

    // --- Dimensions (text overlay) ---
    if (allDimensionsVisible && scene.dimensions) {
      scene.dimensions.forEach((dim) => {
        if (!dim.visible || !isLayerVisible(dim.layer)) return;
        const isHover = hoverEntity && hoverEntity.id === dim.id;
        // Legacy-style colors: selected=cyan, hover=light cyan, driven=orange, constraint=green
        const dimColor = dim.selected ? '#00bfff'
          : (isHover ? '#7fd8ff'
            : (!dim.isConstraint ? '#ffb432'
              : (dim.color || getLayerColor(dim.layer))));
        ctx.strokeStyle = dimColor;
        ctx.fillStyle = dimColor;
        ctx.lineWidth = isHover ? 1.5 : 1;
        ctx.setLineDash([]);

        if (dim.dimType === 'angle') {
          const r = Math.abs(dim.offset) / wpp;
          const startA = dim._angleStart != null ? dim._angleStart : 0;
          const sweepA = dim._angleSweep != null ? dim._angleSweep : 0;
          const cpt = sketchPtToScreen(dim.x1, dim.y1);
          ctx.beginPath();
          ctx.arc(cpt.x, cpt.y, r, -startA, -(startA + sweepA), true);
          ctx.stroke();
          const midA = startA + sweepA / 2;
          const lpt = sketchPtToScreen(
            dim.x1 + (Math.abs(dim.offset) + 14 * wpp) * Math.cos(midA),
            dim.y1 + (Math.abs(dim.offset) + 14 * wpp) * Math.sin(midA)
          );
          const label = dim.displayLabel || '';
          ctx.font = '12px Consolas, monospace';
          ctx.textBaseline = 'middle';
          // Draw label background for readability
          const tm = ctx.measureText(label);
          ctx.save();
          ctx.fillStyle = 'rgba(30, 30, 30, 0.75)';
          ctx.fillRect(lpt.x - tm.width / 2 - 3, lpt.y - 8, tm.width + 6, 16);
          ctx.restore();
          ctx.fillStyle = dimColor;
          ctx.textAlign = 'center';
          ctx.fillText(label, lpt.x, lpt.y);
          ctx.textAlign = 'left';
          return;
        }

        const dx = dim.x2 - dim.x1;
        const dy = dim.y2 - dim.y1;
        const len = Math.hypot(dx, dy) || 1e-9;
        const nx = -dy / len, ny = dx / len;
        let d1, d2;

        if (dim.dimType === 'dx') {
          const dimY = dim.y1 + dim.offset;
          d1 = { x: dim.x1, y: dimY };
          d2 = { x: dim.x2, y: dimY };
        } else if (dim.dimType === 'dy') {
          const dimX = dim.x1 + dim.offset;
          d1 = { x: dimX, y: dim.y1 };
          d2 = { x: dimX, y: dim.y2 };
        } else {
          d1 = { x: dim.x1 + nx * dim.offset, y: dim.y1 + ny * dim.offset };
          d2 = { x: dim.x2 + nx * dim.offset, y: dim.y2 + ny * dim.offset };
        }

        const sp1 = sketchPtToScreen(dim.x1, dim.y1);
        const sp2 = sketchPtToScreen(dim.x2, dim.y2);
        const sd1 = sketchPtToScreen(d1.x, d1.y);
        const sd2 = sketchPtToScreen(d2.x, d2.y);

        ctx.beginPath();
        ctx.moveTo(sp1.x, sp1.y);
        ctx.lineTo(sd1.x, sd1.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sp2.x, sp2.y);
        ctx.lineTo(sd2.x, sd2.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(sd1.x, sd1.y);
        ctx.lineTo(sd2.x, sd2.y);
        ctx.stroke();

        // Arrowheads — scale with zoom, capped at a max size
        const pixelDist = Math.hypot(sd2.x - sd1.x, sd2.y - sd1.y);
        const baseArrowLen = 8;
        const ARROW_HEAD_ANGLE = 0.35; // half-angle of arrowhead in radians (~20°)
        const arrowLen = Math.min(baseArrowLen, pixelDist / 4);
        if (arrowLen > 1) {
          const angle = Math.atan2(sd2.y - sd1.y, sd2.x - sd1.x);
          // Use outside arrows when distance is too small to fit two inside
          const useOutside = pixelDist < baseArrowLen * 4;
          const drawArrow = (ax, ay, aAngle) => {
            ctx.beginPath();
            ctx.moveTo(ax, ay);
            ctx.lineTo(ax - arrowLen * Math.cos(aAngle - ARROW_HEAD_ANGLE), ay - arrowLen * Math.sin(aAngle - ARROW_HEAD_ANGLE));
            ctx.lineTo(ax - arrowLen * Math.cos(aAngle + ARROW_HEAD_ANGLE), ay - arrowLen * Math.sin(aAngle + ARROW_HEAD_ANGLE));
            ctx.closePath();
            ctx.fill();
          };
          if (useOutside) {
            drawArrow(sd1.x, sd1.y, angle);
            drawArrow(sd2.x, sd2.y, angle + Math.PI);
          } else {
            drawArrow(sd1.x, sd1.y, angle + Math.PI);
            drawArrow(sd2.x, sd2.y, angle);
          }
        }

        const mx = (d1.x + d2.x) / 2;
        const my = (d1.y + d2.y) / 2 + 12 * wpp;
        const mpt = sketchPtToScreen(mx, my);
        const label = dim.displayLabel || '';
        ctx.font = '12px Consolas, monospace';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        // Draw label background for readability
        const tm = ctx.measureText(label);
        ctx.save();
        ctx.fillStyle = 'rgba(30, 30, 30, 0.75)';
        ctx.fillRect(mpt.x - tm.width / 2 - 3, mpt.y - 8, tm.width + 6, 16);
        ctx.restore();
        ctx.fillStyle = dimColor;
        ctx.fillText(label, mpt.x, mpt.y);
        ctx.textAlign = 'left';
      });
    }

    // --- Texts ---
    if (scene.texts) {
      scene.texts.forEach((text) => {
        if (!text.visible || !isLayerVisible(text.layer)) return;
        const color = text.selected ? '#00bfff' : (text.color || getLayerColor(text.layer));
        ctx.fillStyle = color;
        ctx.font = '14px Consolas, monospace';
        ctx.textBaseline = 'middle';
        const tpt = sketchPtToScreen(text.x, text.y);
        ctx.save();
        ctx.translate(tpt.x, tpt.y);
        if (text.rotation) ctx.rotate(-text.rotation * Math.PI / 180);
        ctx.fillText(text.text, 0, 0);
        ctx.restore();
      });
    }

    // --- Spline control point handles (overlay, shown when selected) ---
    if (scene.splines) {
      scene.splines.forEach((spl) => {
        if (!spl.visible || !isLayerVisible(spl.layer)) return;
        if (!spl.selected) return; // only show handles for selected splines
        const pts = spl.points;
        if (!pts || pts.length < 2) return;

        // Draw control polygon (dashed lines connecting control points)
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(255, 180, 50, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        const sp0 = sketchPtToScreen(pts[0].x, pts[0].y);
        ctx.moveTo(sp0.x, sp0.y);
        for (let i = 1; i < pts.length; i++) {
          const sp = sketchPtToScreen(pts[i].x, pts[i].y);
          ctx.lineTo(sp.x, sp.y);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw control point handles (small diamonds)
        for (let i = 0; i < pts.length; i++) {
          const cp = pts[i];
          const sp = sketchPtToScreen(cp.x, cp.y);
          const isEndpoint = i === 0 || i === pts.length - 1;
          const handleSize = isEndpoint ? 4 : 3;
          ctx.fillStyle = isEndpoint ? '#00bfff' : '#ffb432';
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1;
          // Diamond shape for interior control points, square for endpoints
          if (isEndpoint) {
            ctx.fillRect(sp.x - handleSize, sp.y - handleSize, handleSize * 2, handleSize * 2);
            ctx.strokeRect(sp.x - handleSize, sp.y - handleSize, handleSize * 2, handleSize * 2);
          } else {
            ctx.beginPath();
            ctx.moveTo(sp.x, sp.y - handleSize - 1);
            ctx.lineTo(sp.x + handleSize + 1, sp.y);
            ctx.lineTo(sp.x, sp.y + handleSize + 1);
            ctx.lineTo(sp.x - handleSize - 1, sp.y);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
          }
        }
        ctx.restore();
      });
    }

    // --- Bezier control point handles (overlay, shown when selected) ---
    if (scene.beziers) {
      scene.beziers.forEach((bez) => {
        if (!bez.visible || !isLayerVisible(bez.layer)) return;
        if (!bez.selected) return;

        ctx.save();
        for (let vi = 0; vi < bez.vertices.length; vi++) {
          const v = bez.vertices[vi];
          const sp = sketchPtToScreen(v.point.x, v.point.y);

          // Draw handle lines and control points
          ctx.strokeStyle = v.tangent ? 'rgba(255, 152, 0, 0.7)' : 'rgba(136, 136, 136, 0.7)';
          ctx.lineWidth = 1;

          if (v.handleIn) {
            const hx = v.point.x + v.handleIn.dx, hy = v.point.y + v.handleIn.dy;
            const hs = sketchPtToScreen(hx, hy);
            ctx.beginPath();
            ctx.moveTo(sp.x, sp.y);
            ctx.lineTo(hs.x, hs.y);
            ctx.stroke();
            ctx.fillStyle = v.tangent ? '#ff9800' : '#888';
            ctx.beginPath();
            ctx.arc(hs.x, hs.y, 3, 0, Math.PI * 2);
            ctx.fill();
          }
          if (v.handleOut) {
            const hx = v.point.x + v.handleOut.dx, hy = v.point.y + v.handleOut.dy;
            const hs = sketchPtToScreen(hx, hy);
            ctx.beginPath();
            ctx.moveTo(sp.x, sp.y);
            ctx.lineTo(hs.x, hs.y);
            ctx.stroke();
            ctx.fillStyle = v.tangent ? '#ff9800' : '#888';
            ctx.beginPath();
            ctx.arc(hs.x, hs.y, 3, 0, Math.PI * 2);
            ctx.fill();
          }

          // Vertex point (diamond for tangent, square for corner)
          ctx.fillStyle = '#00bfff';
          if (v.tangent) {
            ctx.save();
            ctx.translate(sp.x, sp.y);
            ctx.rotate(Math.PI / 4);
            ctx.fillRect(-3, -3, 6, 6);
            ctx.restore();
          } else {
            ctx.fillRect(sp.x - 3, sp.y - 3, 6, 6);
          }
        }
        ctx.restore();
      });
    }

    // --- Preview entity handles (shown during drawing with bezier/spline tools) ---
    if (previewEntities && previewEntities.length > 0) {
      for (const entity of previewEntities) {
        if (!entity) continue;
        if (entity.type === 'spline' && entity.points && entity.points.length >= 2) {
          // Draw control polygon for preview spline
          ctx.save();
          ctx.setLineDash([4, 4]);
          ctx.strokeStyle = 'rgba(0, 191, 255, 0.5)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          const sp0 = sketchPtToScreen(entity.points[0].x, entity.points[0].y);
          ctx.moveTo(sp0.x, sp0.y);
          for (let i = 1; i < entity.points.length; i++) {
            const sp = sketchPtToScreen(entity.points[i].x, entity.points[i].y);
            ctx.lineTo(sp.x, sp.y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          // Draw control point markers
          for (let i = 0; i < entity.points.length; i++) {
            const cp = entity.points[i];
            const sp = sketchPtToScreen(cp.x, cp.y);
            const isEnd = i === 0 || i === entity.points.length - 1;
            ctx.fillStyle = isEnd ? '#00bfff' : 'rgba(0, 191, 255, 0.6)';
            ctx.fillRect(sp.x - 3, sp.y - 3, 6, 6);
          }
          ctx.restore();
        } else if (entity.type === 'bezier' && entity.vertices && entity.vertices.length >= 2) {
          // Draw handle lines and markers for preview bezier
          ctx.save();
          for (let vi = 0; vi < entity.vertices.length; vi++) {
            const v = entity.vertices[vi];
            const sp = sketchPtToScreen(v.point.x, v.point.y);
            ctx.strokeStyle = 'rgba(0, 191, 255, 0.6)';
            ctx.lineWidth = 1;
            if (v.handleIn) {
              const hx = v.point.x + v.handleIn.dx, hy = v.point.y + v.handleIn.dy;
              const hs = sketchPtToScreen(hx, hy);
              ctx.beginPath(); ctx.moveTo(sp.x, sp.y); ctx.lineTo(hs.x, hs.y); ctx.stroke();
              ctx.fillStyle = '#00bfff';
              ctx.beginPath(); ctx.arc(hs.x, hs.y, 3, 0, Math.PI * 2); ctx.fill();
            }
            if (v.handleOut) {
              const hx = v.point.x + v.handleOut.dx, hy = v.point.y + v.handleOut.dy;
              const hs = sketchPtToScreen(hx, hy);
              ctx.beginPath(); ctx.moveTo(sp.x, sp.y); ctx.lineTo(hs.x, hs.y); ctx.stroke();
              ctx.fillStyle = '#00bfff';
              ctx.beginPath(); ctx.arc(hs.x, hs.y, 3, 0, Math.PI * 2); ctx.fill();
            }
            // Vertex marker
            ctx.fillStyle = '#00bfff';
            ctx.fillRect(sp.x - 3, sp.y - 3, 6, 6);
          }
          ctx.restore();
        }
      }
    }

    if (this._sketchPlane) {
      const pd = this._sketchPlaneDef;
      const axisLen = in3DSketch ? 50 : Math.max(this._orthoBounds.right - this._orthoBounds.left, this._orthoBounds.top - this._orthoBounds.bottom) * 0.6;

      // Compute world origin (0,0,0) in sketch-local 2D coordinates
      let olx = 0, oly = 0;
      if (pd) {
        // Vector from plane origin to world origin
        const dx = -pd.origin.x, dy = -pd.origin.y, dz = -pd.origin.z;
        olx = dx * pd.xAxis.x + dy * pd.xAxis.y + dz * pd.xAxis.z;
        oly = dx * pd.yAxis.x + dy * pd.yAxis.y + dz * pd.yAxis.z;
      }

      const origin = sketchPtToScreen(olx, oly);
      const ox = origin.x;
      const oy = origin.y;

      // Determine axis labels and colors based on which world axis aligns with sketch axes
      let hLabel, vLabel, hColor, vColor;
      const worldColors = { X: '#ff4444', Y: '#44ff44', Z: '#4488ff' };
      if (pd && this._sketchPlane === 'FACE') {
        // Find which world axis best aligns with xAxis and yAxis
        const xa = pd.xAxis, ya = pd.yAxis;
        const axes = [
          { name: 'X', v: { x: 1, y: 0, z: 0 } },
          { name: 'Y', v: { x: 0, y: 1, z: 0 } },
          { name: 'Z', v: { x: 0, y: 0, z: 1 } },
        ];
        let bestH = axes[0], bestHDot = 0;
        let bestV = axes[0], bestVDot = 0;
        for (const a of axes) {
          const dh = Math.abs(xa.x * a.v.x + xa.y * a.v.y + xa.z * a.v.z);
          const dv = Math.abs(ya.x * a.v.x + ya.y * a.v.y + ya.z * a.v.z);
          if (dh > bestHDot) { bestHDot = dh; bestH = a; }
          if (dv > bestVDot) { bestVDot = dv; bestV = a; }
        }
        hLabel = bestH.name; hColor = worldColors[bestH.name];
        vLabel = bestV.name; vColor = worldColors[bestV.name];
      } else {
        switch (this._sketchPlane) {
          case 'XY': hLabel = 'X'; vLabel = 'Y'; hColor = worldColors.X; vColor = worldColors.Y; break;
          case 'XZ': hLabel = 'X'; vLabel = 'Z'; hColor = worldColors.X; vColor = worldColors.Z; break;
          case 'YZ': hLabel = 'Y'; vLabel = 'Z'; hColor = worldColors.Y; vColor = worldColors.Z; break;
          default:   hLabel = 'X'; vLabel = 'Y'; hColor = worldColors.X; vColor = worldColors.Y; break;
        }
      }

      // Horizontal axis (positive direction to the right)
      const hEnd = sketchPtToScreen(olx + axisLen, oly);
      ctx.save();
      ctx.strokeStyle = hColor;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(hEnd.x, hEnd.y);
      ctx.stroke();
      // Arrow
      const hDx = hEnd.x - ox, hDy = hEnd.y - oy;
      const hLen = Math.hypot(hDx, hDy) || 1;
      const hUx = hDx / hLen, hUy = hDy / hLen;
      ctx.beginPath();
      ctx.moveTo(hEnd.x, hEnd.y);
      ctx.lineTo(hEnd.x - 8 * hUx - 4 * hUy, hEnd.y - 8 * hUy + 4 * hUx);
      ctx.moveTo(hEnd.x, hEnd.y);
      ctx.lineTo(hEnd.x - 8 * hUx + 4 * hUy, hEnd.y - 8 * hUy - 4 * hUx);
      ctx.stroke();
      // Label
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = hColor;
      ctx.font = 'bold 13px Consolas, monospace';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(hLabel, hEnd.x + 4 * hUx, hEnd.y + 4 * hUy);
      ctx.restore();

      // Vertical axis (positive direction upward)
      const vEnd = sketchPtToScreen(olx, oly + axisLen);
      ctx.save();
      ctx.strokeStyle = vColor;
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.6;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(ox, oy);
      ctx.lineTo(vEnd.x, vEnd.y);
      ctx.stroke();
      // Arrow
      const vDx = vEnd.x - ox, vDy = vEnd.y - oy;
      const vLen = Math.hypot(vDx, vDy) || 1;
      const vUx = vDx / vLen, vUy = vDy / vLen;
      ctx.beginPath();
      ctx.moveTo(vEnd.x, vEnd.y);
      ctx.lineTo(vEnd.x - 8 * vUx - 4 * vUy, vEnd.y - 8 * vUy + 4 * vUx);
      ctx.moveTo(vEnd.x, vEnd.y);
      ctx.lineTo(vEnd.x - 8 * vUx + 4 * vUy, vEnd.y - 8 * vUy - 4 * vUx);
      ctx.stroke();
      // Label
      ctx.globalAlpha = 0.8;
      ctx.fillStyle = vColor;
      ctx.font = 'bold 13px Consolas, monospace';
      ctx.textBaseline = 'bottom';
      ctx.textAlign = 'center';
      ctx.fillText(vLabel, vEnd.x, vEnd.y - 4);
      ctx.restore();

      // Origin marker
      ctx.save();
      ctx.fillStyle = '#ffffff';
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(ox, oy, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // --- Constraint icons ---
    if (constraintIconsVisible && scene.constraints) {
      const iconMap = {
        coincident: '⊙', distance: '↔', fixed: '⊕',
        horizontal: 'H', vertical: 'V', parallel: '∥', perpendicular: '⊥',
        angle: '∠', equal_length: '=', length: 'L', radius: 'R', tangent: 'T',
        on_line: '—·', on_circle: '○·', midpoint: 'M',
      };
      scene.constraints.forEach((constraint) => {
        if (constraint.type === 'dimension') return;
        if (typeof constraint.involvedPoints !== 'function') return;
        const pts = constraint.involvedPoints();
        if (!pts || pts.length === 0) return;
        let cx = 0, cy = 0;
        for (const p of pts) { cx += p.x; cy += p.y; }
        cx /= pts.length; cy /= pts.length;
        const icon = iconMap[constraint.type] || '?';
        const ok = (typeof constraint.error === 'function') ? constraint.error() < 1e-4 : false;
        ctx.fillStyle = ok ? '#00e676' : '#ff643c';
        ctx.font = '13px Consolas, monospace';
        const cpt = sketchPtToScreen(cx + 12 * wpp, cy + 10 * wpp);
        ctx.fillText(icon, cpt.x, cpt.y);
      });
    }

    // --- Closed-region fills (paint closed polygon/circle loops with holes subtracted) ---
    // Use even-odd fill rule so that overlapping/nested loops correctly subtract holes.
    const PROFILE_FILL = 'rgba(100,180,255,0.10)';

    const visibleProfiles = extractRenderableSketchProfiles(scene, isLayerVisible);
    // Build all valid profiles into a single compound path so that
    // nested loops (holes) are correctly subtracted via the even-odd rule.
    if (visibleProfiles.length > 0) {
      ctx.beginPath();
      for (const profile of visibleProfiles) {
        _appendPolylineProfilePath(ctx, profile, (point) => sketchPtToScreen(point.x, point.y));
      }
      ctx.fillStyle = PROFILE_FILL;
      ctx.fill('evenodd');
    }

    // --- Selection grips (blue squares at snap points of selected entities) ---
    ctx.fillStyle = '#00bfff';
    const allEntities = [
      ...(scene.segments || []),
      ...(scene.circles || []),
      ...(scene.arcs || []),
      ...(scene.splines || []),
      ...(scene.beziers || []),
      ...(scene.dimensions || []),
    ];
    for (const entity of allEntities) {
      if (!entity.selected || !entity.visible) continue;
      const snaps = entity.getSnapPoints ? entity.getSnapPoints().filter(s => s.type === 'endpoint' || s.type === 'center') : [];
      for (const snap of snaps) {
        const s = sketchPtToScreen(snap.x, snap.y);
        ctx.fillRect(s.x - 3, s.y - 3, 6, 6);
      }
    }

    // --- Point rings (circles around selected and hovered points for clarity) ---
    if (scene.points) {
      scene.points.forEach((point) => {
        const isHover = hoverEntity && hoverEntity.id === point.id;
        if (!point.selected && !isHover) return;
        const s = sketchPtToScreen(point.x, point.y);
        const isFCPt = fc.points.has(point);
        const r = point.selected ? 5.5 : (isHover ? 5 : ((point.fixed || isFCPt) ? 4.5 : 3.5));
        ctx.strokeStyle = point.selected ? '#00bfff' : '#7fd8ff';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(s.x, s.y, r + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      });
    }

    // --- Snap indicator shapes (different shapes per snap type) ---
    if (snapPoint) {
      const snapScreen = sketchPtToScreen(snapPoint.x, snapPoint.y);
      _drawSnapIndicator(ctx, snapScreen, snapPoint.type || 'endpoint');
    }

    // --- Crosshair with gap around cursor ---
    if (cursorWorld && (this.mode === '2d' || this._sketchPlane)) {
      const cs = sketchPtToScreen(cursorWorld.x, cursorWorld.y);
      const gap = 10;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 0.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      // Horizontal line with gap
      ctx.moveTo(0, cs.y);
      ctx.lineTo(cs.x - gap, cs.y);
      ctx.moveTo(cs.x + gap, cs.y);
      ctx.lineTo(w, cs.y);
      // Vertical line with gap
      ctx.moveTo(cs.x, 0);
      ctx.lineTo(cs.x, cs.y - gap);
      ctx.moveTo(cs.x, cs.y + gap);
      ctx.lineTo(cs.x, h);
      ctx.stroke();
      ctx.restore();
    }

    // --- Active tool overlay (selection box, snap indicators, etc.) ---
    if (activeTool && typeof activeTool.drawOverlay === 'function') {
      activeTool.drawOverlay(ctx, { worldToScreen: sketchPtToScreen });
    }
  }

  /* ---------- 3D Part Rendering ---------- */

  renderPart(part) {
    if (!part || !this._ready) return;
    this._renderedPart = part;

    // Update origin plane visibility in WASM
    if (this.wasm && this.wasm.setOriginPlanesVisible) {
      const planes = part.getOriginPlanes ? part.getOriginPlanes() : {};
      let mask = 0;
      if (!planes.XY || planes.XY.visible) mask |= 1;
      if (!planes.XZ || planes.XZ.visible) mask |= 2;
      if (!planes.YZ || planes.YZ.visible) mask |= 4;
      this._originPlaneVisibilityMask = mask;
      this.wasm.setOriginPlanesVisible(mask);
    }

    const geo = part.getFinalGeometry();
    if (!geo) {
      this._clearMeshRenderData();
      // Still build sketch wireframes even without solid geometry
      this._buildSketchWireframes(part);
      return;
    }

    if (geo.type === 'solid' && geo.geometry) {
      const bb = geo.boundingBox;
      if (bb) this._partBounds = bb;

      // Build actual mesh from geometry faces
      this._buildMeshFromGeometry(geo.geometry, geo);
    } else {
      this._clearMeshRenderData();
    }

    // Build sketch wireframes for all sketch features (visible in 3D mode)
    this._buildSketchWireframes(part);
  }

  _getImageResource(dataUrl) {
    if (!dataUrl) return null;
    let entry = this._imageResources.get(dataUrl);
    if (entry) return entry;
    const image = new Image();
    entry = {
      image,
      ready: false,
      failed: false,
      processed: new Map(),
      expanded: new Map(),
    };
    image.onload = () => {
      entry.ready = true;
      entry.failed = false;
      entry.processed.clear();
      entry.expanded.clear();
      if (this._last2DScene) {
        this.render2DScene(this._last2DScene, this._last2DOverlays || {});
      }
    };
    image.onerror = () => {
      entry.ready = false;
      entry.failed = true;
      entry.processed.clear();
      entry.expanded.clear();
    };
    image.src = dataUrl;
    this._imageResources.set(dataUrl, entry);
    return entry;
  }

  _getAdjustedImageKey(primitive) {
    return [
      primitive.brightness || 0,
      primitive.contrast || 0,
      primitive.gamma || 1,
      primitive.quantization || 0,
    ].join('|');
  }

  _getAdjustedImageSource(primitive) {
    const entry = this._getImageResource(primitive.dataUrl);
    if (!entry || !entry.ready || !entry.image.naturalWidth || !entry.image.naturalHeight) return null;

    const key = this._getAdjustedImageKey(primitive);

    if (key === '0|0|1|0') return entry.image;
    if (entry.processed.has(key)) return entry.processed.get(key);

    const canvas = document.createElement('canvas');
    canvas.width = entry.image.naturalWidth;
    canvas.height = entry.image.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(entry.image, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    const brightness = Math.max(-1, Math.min(1, primitive.brightness || 0)) * 255;
    const contrastFactor = Math.max(0, 1 + (primitive.contrast || 0));
    const gamma = Math.max(0.01, primitive.gamma || 1);
    const quantLevels = primitive.quantization && primitive.quantization > 1 ? primitive.quantization : 0;
    const quantScale = quantLevels > 1 ? 255 / (quantLevels - 1) : 0;

    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        let value = data[i + c] + brightness;
        value = ((value - 127.5) * contrastFactor) + 127.5;
        value = 255 * Math.pow(Math.max(0, Math.min(1, value / 255)), 1 / gamma);
        if (quantLevels > 1) {
          value = Math.round(value / quantScale) * quantScale;
        }
        data[i + c] = Math.max(0, Math.min(255, value));
      }
    }

    ctx.putImageData(imageData, 0, 0);
    entry.processed.set(key, canvas);
    return canvas;
  }

  _resolvePerspectiveSource(primitive, source, sourceQuad) {
    if (!primitive || !source || !Array.isArray(sourceQuad) || sourceQuad.length !== 4) {
      return { source, normalizedQuad: sourceQuad };
    }

    const bounds = typeof primitive.getSourceQuadBounds === 'function'
      ? primitive.getSourceQuadBounds(sourceQuad)
      : {
        minU: Math.min(...sourceQuad.map((point) => point.u || 0)),
        maxU: Math.max(...sourceQuad.map((point) => point.u || 0)),
        minV: Math.min(...sourceQuad.map((point) => point.v || 0)),
        maxV: Math.max(...sourceQuad.map((point) => point.v || 0)),
        spanU: Math.max(1e-9, Math.max(...sourceQuad.map((point) => point.u || 0)) - Math.min(...sourceQuad.map((point) => point.u || 0))),
        spanV: Math.max(1e-9, Math.max(...sourceQuad.map((point) => point.v || 0)) - Math.min(...sourceQuad.map((point) => point.v || 0))),
      };
    const needsExpansion = bounds.minU < -1e-9 || bounds.maxU > 1 + 1e-9 || bounds.minV < -1e-9 || bounds.maxV > 1 + 1e-9;
    if (!needsExpansion) {
      return { source, normalizedQuad: sourceQuad };
    }

    const entry = this._getImageResource(primitive.dataUrl);
    if (!entry) {
      return { source, normalizedQuad: sourceQuad };
    }

    const cacheKey = [
      this._getAdjustedImageKey(primitive),
      bounds.minU.toFixed(6),
      bounds.maxU.toFixed(6),
      bounds.minV.toFixed(6),
      bounds.maxV.toFixed(6),
    ].join('|');
    if (entry.expanded.has(cacheKey)) {
      return entry.expanded.get(cacheKey);
    }

    const sourceWidth = source.width || source.naturalWidth || 1;
    const sourceHeight = source.height || source.naturalHeight || 1;
    const spanU = Math.max(1e-9, bounds.spanU);
    const spanV = Math.max(1e-9, bounds.spanV);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.ceil(sourceWidth * spanU));
    canvas.height = Math.max(1, Math.ceil(sourceHeight * spanV));
    const expandedCtx = canvas.getContext('2d');
    const pixelsPerUnitU = canvas.width / spanU;
    const pixelsPerUnitV = canvas.height / spanV;
    const drawX = -bounds.minU * pixelsPerUnitU;
    const drawY = (bounds.maxV - 1) * pixelsPerUnitV;
    const drawWidth = pixelsPerUnitU;
    const drawHeight = pixelsPerUnitV;
    expandedCtx.drawImage(source, drawX, drawY, drawWidth, drawHeight);

    const normalizedQuad = typeof primitive.normalizeSourceQuadToBounds === 'function'
      ? primitive.normalizeSourceQuadToBounds(sourceQuad, bounds)
      : sourceQuad;
    const result = { source: canvas, normalizedQuad };
    entry.expanded.set(cacheKey, result);
    return result;
  }

  _createOffscreenCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width));
    canvas.height = Math.max(1, Math.round(height));
    return canvas;
  }

  _scaleRasterSize(width, height, maxRasterSize = 2048) {
    const safeWidth = Math.max(1, Number.isFinite(width) ? width : 1);
    const safeHeight = Math.max(1, Number.isFinite(height) ? height : 1);
    const maxSide = Math.max(256, Math.round(maxRasterSize || 2048));
    const scale = Math.min(1, maxSide / Math.max(safeWidth, safeHeight));
    return {
      width: Math.max(32, Math.round(safeWidth * scale)),
      height: Math.max(32, Math.round(safeHeight * scale)),
    };
  }

  _cropTraceCanvas(sourceCanvas, fullRect, cropRect) {
    const pixelsPerUnitX = sourceCanvas.width / Math.max(1e-9, fullRect.width);
    const pixelsPerUnitY = sourceCanvas.height / Math.max(1e-9, fullRect.height);
    const srcX = Math.max(0, Math.floor((cropRect.x - fullRect.x) * pixelsPerUnitX));
    const srcY = Math.max(0, Math.floor((fullRect.y + fullRect.height - (cropRect.y + cropRect.height)) * pixelsPerUnitY));
    const srcWidth = Math.max(1, Math.ceil(cropRect.width * pixelsPerUnitX));
    const srcHeight = Math.max(1, Math.ceil(cropRect.height * pixelsPerUnitY));
    const clampedWidth = Math.max(1, Math.min(srcWidth, sourceCanvas.width - srcX));
    const clampedHeight = Math.max(1, Math.min(srcHeight, sourceCanvas.height - srcY));
    const canvas = this._createOffscreenCanvas(clampedWidth, clampedHeight);
    const cropCtx = canvas.getContext('2d');
    cropCtx.drawImage(sourceCanvas, srcX, srcY, clampedWidth, clampedHeight, 0, 0, canvas.width, canvas.height);
    return {
      canvas,
      localRect: {
        x: cropRect.x,
        y: cropRect.y,
        width: cropRect.width,
        height: cropRect.height,
      },
    };
  }

  buildTraceImageRaster(primitive, options = {}) {
    const source = this._getAdjustedImageSource(primitive);
    if (!source) return null;

    const hasAppliedPerspective = typeof primitive.hasAppliedPerspectiveCorrection === 'function'
      ? primitive.hasAppliedPerspectiveCorrection()
      : !!primitive.perspectiveEnabled;

    if (!hasAppliedPerspective) {
      const baseWidth = source.width || source.naturalWidth || 1;
      const baseHeight = source.height || source.naturalHeight || 1;
      const rasterSize = this._scaleRasterSize(baseWidth, baseHeight, options.maxRasterSize);
      const canvas = this._createOffscreenCanvas(rasterSize.width, rasterSize.height);
      const rasterCtx = canvas.getContext('2d');
      rasterCtx.drawImage(source, 0, 0, canvas.width, canvas.height);
      return {
        canvas,
        localRect: {
          x: 0,
          y: 0,
          width: Math.max(0.01, primitive.width || 1),
          height: Math.max(0.01, primitive.height || 1),
        },
      };
    }

    const fullRect = {
      x: 0,
      y: 0,
      width: Math.max(0.01, primitive.gridWidth || primitive.width || 1),
      height: Math.max(0.01, primitive.gridHeight || primitive.height || 1),
    };
    const resolvedSource = this._resolvePerspectiveSource(primitive, source, primitive.sourceQuad);
    const renderSource = resolvedSource.source;
    const normalizedSourceQuad = resolvedSource.normalizedQuad;
    const renderSourceWidth = renderSource.width || renderSource.naturalWidth || 1;
    const renderSourceHeight = renderSource.height || renderSource.naturalHeight || 1;
    const rasterSize = this._scaleRasterSize(renderSourceWidth, renderSourceHeight, options.maxRasterSize);
    const canvas = this._createOffscreenCanvas(rasterSize.width, rasterSize.height);
    const rasterCtx = canvas.getContext('2d');
    const sourceQuadPixels = _sourceQuadToPixels(normalizedSourceQuad, renderSourceWidth, renderSourceHeight);
    const destQuadPixels = [
      { x: 0, y: canvas.height },
      { x: canvas.width, y: canvas.height },
      { x: canvas.width, y: 0 },
      { x: 0, y: 0 },
    ];
    const subdivisions = 12;
    for (let iy = 0; iy < subdivisions; iy++) {
      const v0 = iy / subdivisions;
      const v1 = (iy + 1) / subdivisions;
      for (let ix = 0; ix < subdivisions; ix++) {
        const u0 = ix / subdivisions;
        const u1 = (ix + 1) / subdivisions;
        const src00 = _bilinearQuadPoint(sourceQuadPixels, u0, v0);
        const src10 = _bilinearQuadPoint(sourceQuadPixels, u1, v0);
        const src11 = _bilinearQuadPoint(sourceQuadPixels, u1, v1);
        const src01 = _bilinearQuadPoint(sourceQuadPixels, u0, v1);
        const dst00 = _bilinearQuadPoint(destQuadPixels, u0, v0);
        const dst10 = _bilinearQuadPoint(destQuadPixels, u1, v0);
        const dst11 = _bilinearQuadPoint(destQuadPixels, u1, v1);
        const dst01 = _bilinearQuadPoint(destQuadPixels, u0, v1);
        _transformSourceTriangleToDest(rasterCtx, renderSource, [src00, src10, src11], [dst00, dst10, dst11]);
        _transformSourceTriangleToDest(rasterCtx, renderSource, [src00, src11, src01], [dst00, dst11, dst01]);
      }
    }

    const cropRect = typeof primitive.getCropRect === 'function' ? primitive.getCropRect() : null;
    return cropRect
      ? this._cropTraceCanvas(canvas, fullRect, cropRect)
      : { canvas, localRect: fullRect };
  }

  _drawSketchImageOverlay(ctx, primitive, projectPoint, options = {}) {
    const source = this._getAdjustedImageSource(primitive);
    if (!source) return false;

    const destQuadWorld = typeof primitive.getWarpWorldQuad === 'function'
      ? primitive.getWarpWorldQuad()
      : primitive.getWorldQuad();
    const destQuadScreen = destQuadWorld.map((point) => projectPoint(point.x, point.y));
    if (destQuadScreen.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      return false;
    }
    const visibleQuadWorld = primitive.getWorldQuad();
    const visibleQuadScreen = visibleQuadWorld.map((point) => projectPoint(point.x, point.y));
    const cropQuadWorld = typeof primitive.getCropWorldQuad === 'function'
      ? primitive.getCropWorldQuad()
      : null;
    const cropQuadScreen = cropQuadWorld
      ? cropQuadWorld.map((point) => projectPoint(point.x, point.y))
      : null;

    const renderSourceQuad = typeof primitive.getRenderSourceQuad === 'function'
      ? primitive.getRenderSourceQuad()
      : primitive.sourceQuad;
    const guideSourceQuad = typeof primitive.getPerspectiveGuideQuad === 'function'
      ? primitive.getPerspectiveGuideQuad()
      : primitive.sourceQuad;
    const resolvedSource = this._resolvePerspectiveSource(primitive, source, renderSourceQuad);
    const renderSource = resolvedSource.source;
    const normalizedRenderSourceQuad = resolvedSource.normalizedQuad;
    const sourceQuadPixels = _sourceQuadToPixels(normalizedRenderSourceQuad, renderSource.width || renderSource.naturalWidth, renderSource.height || renderSource.naturalHeight);
    const hasAppliedPerspectiveOutput = !!(primitive.perspectiveOutputQuad && !(typeof primitive.isPerspectiveEditing === 'function' && primitive.isPerspectiveEditing()));
    const useWarp = hasAppliedPerspectiveOutput
      || primitive.rotation
      || primitive.scaleX !== 1
      || primitive.scaleY !== 1
      || !_isIdentitySourceQuad(renderSourceQuad);

    ctx.save();
    if (cropQuadScreen && cropQuadScreen.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))) {
      _traceQuadPath(ctx, cropQuadScreen);
      ctx.clip();
    }
    ctx.globalAlpha = Math.max(0.05, Math.min(1, primitive.opacity || 0.8));
    if (!useWarp) {
      const minX = Math.min(...destQuadScreen.map((point) => point.x));
      const maxX = Math.max(...destQuadScreen.map((point) => point.x));
      const minY = Math.min(...destQuadScreen.map((point) => point.y));
      const maxY = Math.max(...destQuadScreen.map((point) => point.y));
      ctx.drawImage(renderSource, minX, minY, maxX - minX, maxY - minY);
    } else {
      const subdivisions = primitive.perspectiveEnabled ? 10 : 4;
      for (let iy = 0; iy < subdivisions; iy++) {
        const v0 = iy / subdivisions;
        const v1 = (iy + 1) / subdivisions;
        for (let ix = 0; ix < subdivisions; ix++) {
          const u0 = ix / subdivisions;
          const u1 = (ix + 1) / subdivisions;
          const src00 = _bilinearQuadPoint(sourceQuadPixels, u0, v0);
          const src10 = _bilinearQuadPoint(sourceQuadPixels, u1, v0);
          const src11 = _bilinearQuadPoint(sourceQuadPixels, u1, v1);
          const src01 = _bilinearQuadPoint(sourceQuadPixels, u0, v1);
          const dst00 = _bilinearQuadPoint(destQuadScreen, u0, v0);
          const dst10 = _bilinearQuadPoint(destQuadScreen, u1, v0);
          const dst11 = _bilinearQuadPoint(destQuadScreen, u1, v1);
          const dst01 = _bilinearQuadPoint(destQuadScreen, u0, v1);
          _transformSourceTriangleToDest(ctx, renderSource, [src00, src10, src11], [dst00, dst10, dst11]);
          _transformSourceTriangleToDest(ctx, renderSource, [src00, src11, src01], [dst00, dst11, dst01]);
        }
      }
    }
    ctx.restore();

    if (options.drawOutline) {
      ctx.save();
      ctx.strokeStyle = options.outlineColor || '#00bfff';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      _traceQuadPath(ctx, visibleQuadScreen);
      ctx.stroke();
      ctx.restore();
    }

    if (options.drawPerspectiveGuides) {
      const handlePoints = guideSourceQuad.map((point) => _bilinearQuadPoint(destQuadScreen, point.u, point.v));
      ctx.save();
      ctx.strokeStyle = 'rgba(255, 196, 64, 0.9)';
      ctx.fillStyle = 'rgba(255, 196, 64, 0.95)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(handlePoints[0].x, handlePoints[0].y);
      for (let i = 1; i < handlePoints.length; i++) ctx.lineTo(handlePoints[i].x, handlePoints[i].y);
      ctx.closePath();
      ctx.stroke();
      for (const [a, b] of buildProjectiveGridGuides(handlePoints, primitive.gridCellsX || 3, primitive.gridCellsY || 3)) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      for (const point of handlePoints) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    return true;
  }

  _renderSceneImageOverlay(ctx, scene, options = {}) {
    if (!ctx || !scene?.images || scene.images.length === 0) return;
    const isLayerVisible = options.isLayerVisible || (() => true);
    const selectedIds = options.selectedEntityIds || new Set();
    const hoverEntity = options.hoverEntity || null;
    for (const image of scene.images) {
      if (!image.visible || !isLayerVisible(image.layer)) continue;
      this._drawSketchImageOverlay(ctx, image, options.sketchPtToScreen, {
        drawOutline: selectedIds.has(image.id) || hoverEntity?.id === image.id,
        outlineColor: selectedIds.has(image.id) ? '#00bfff' : '#7fd8ff',
        drawPerspectiveGuides: typeof image.isPerspectiveEditing === 'function' && image.isPerspectiveEditing(),
      });
    }
  }

  _renderPartSketchImagesOverlay() {
    const ctx = this.overlayCtx;
    if (!ctx) return;
    const width = this._cssWidth || this.container.clientWidth;
    const height = this._cssHeight || this.container.clientHeight;
    ctx.clearRect(0, 0, width, height);
    const imageDescriptors = this._partSketchImages || [];
    if (!imageDescriptors.length) return;

    const projectPoint = (wx, wy, wz) => this.worldToScreen(wx, wy, wz);
    for (const descriptor of imageDescriptors) {
      const { image, plane, selected } = descriptor;
      if (!image || image.visible === false) continue;
      const visibleLocalQuad = image.getWorldQuad();
      const warpLocalQuad = typeof image.getWarpWorldQuad === 'function'
        ? image.getWarpWorldQuad()
        : visibleLocalQuad;
      const cropLocalQuad = typeof image.getCropWorldQuad === 'function'
        ? image.getCropWorldQuad()
        : null;
      const worldQuad = warpLocalQuad.map((point) => ({
        x: plane.origin.x + point.x * plane.xAxis.x + point.y * plane.yAxis.x,
        y: plane.origin.y + point.x * plane.xAxis.y + point.y * plane.yAxis.y,
        z: plane.origin.z + point.x * plane.xAxis.z + point.y * plane.yAxis.z,
      }));
      const visibleWorldQuad = visibleLocalQuad.map((point) => ({
        x: plane.origin.x + point.x * plane.xAxis.x + point.y * plane.yAxis.x,
        y: plane.origin.y + point.x * plane.xAxis.y + point.y * plane.yAxis.y,
        z: plane.origin.z + point.x * plane.xAxis.z + point.y * plane.yAxis.z,
      }));
      const cropWorldQuad = cropLocalQuad
        ? cropLocalQuad.map((point) => ({
          x: plane.origin.x + point.x * plane.xAxis.x + point.y * plane.yAxis.x,
          y: plane.origin.y + point.x * plane.xAxis.y + point.y * plane.yAxis.y,
          z: plane.origin.z + point.x * plane.xAxis.z + point.y * plane.yAxis.z,
        }))
        : null;
      const temp = {
        ...image,
        getWorldQuad: () => visibleWorldQuad.map((point) => ({ x: point.x, y: point.y, z: point.z })),
        getWarpWorldQuad: () => worldQuad.map((point) => ({ x: point.x, y: point.y, z: point.z })),
        getCropWorldQuad: () => cropWorldQuad ? cropWorldQuad.map((point) => ({ x: point.x, y: point.y, z: point.z })) : null,
      };
      this._drawPartSketchImageOverlay(ctx, temp, projectPoint, selected);
    }
  }

  _drawPartSketchImageOverlay(ctx, image, projectPoint, selected) {
    const source = this._getAdjustedImageSource(image);
    if (!source) return false;

    const destQuadWorld = typeof image.getWarpWorldQuad === 'function'
      ? image.getWarpWorldQuad()
      : image.getWorldQuad();
    const destQuadScreen = destQuadWorld.map((point) => projectPoint(point.x, point.y, point.z));
    if (destQuadScreen.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      return false;
    }
    const visibleQuadWorld = image.getWorldQuad();
    const visibleQuadScreen = visibleQuadWorld.map((point) => projectPoint(point.x, point.y, point.z));
    const cropQuadWorld = typeof image.getCropWorldQuad === 'function'
      ? image.getCropWorldQuad()
      : null;
    const cropQuadScreen = cropQuadWorld
      ? cropQuadWorld.map((point) => projectPoint(point.x, point.y, point.z))
      : null;

    const renderSourceQuad = typeof image.getRenderSourceQuad === 'function'
      ? image.getRenderSourceQuad()
      : image.sourceQuad;
    const resolvedSource = this._resolvePerspectiveSource(image, source, renderSourceQuad);
    const renderSource = resolvedSource.source;
    const normalizedRenderSourceQuad = resolvedSource.normalizedQuad;
    const sourceQuadPixels = _sourceQuadToPixels(normalizedRenderSourceQuad, renderSource.width || renderSource.naturalWidth, renderSource.height || renderSource.naturalHeight);
    ctx.save();
    if (cropQuadScreen && cropQuadScreen.every((point) => point && Number.isFinite(point.x) && Number.isFinite(point.y))) {
      _traceQuadPath(ctx, cropQuadScreen);
      ctx.clip();
    }
    ctx.globalAlpha = Math.max(0.05, Math.min(0.65, image.opacity || 0.8));
    const subdivisions = image.perspectiveEnabled ? 10 : 4;
    for (let iy = 0; iy < subdivisions; iy++) {
      const v0 = iy / subdivisions;
      const v1 = (iy + 1) / subdivisions;
      for (let ix = 0; ix < subdivisions; ix++) {
        const u0 = ix / subdivisions;
        const u1 = (ix + 1) / subdivisions;
        const src00 = _bilinearQuadPoint(sourceQuadPixels, u0, v0);
        const src10 = _bilinearQuadPoint(sourceQuadPixels, u1, v0);
        const src11 = _bilinearQuadPoint(sourceQuadPixels, u1, v1);
        const src01 = _bilinearQuadPoint(sourceQuadPixels, u0, v1);
        const dst00 = _bilinearQuadPoint(destQuadScreen, u0, v0);
        const dst10 = _bilinearQuadPoint(destQuadScreen, u1, v0);
        const dst11 = _bilinearQuadPoint(destQuadScreen, u1, v1);
        const dst01 = _bilinearQuadPoint(destQuadScreen, u0, v1);
        _transformSourceTriangleToDest(ctx, renderSource, [src00, src10, src11], [dst00, dst10, dst11]);
        _transformSourceTriangleToDest(ctx, renderSource, [src00, src11, src01], [dst00, dst11, dst01]);
      }
    }
    ctx.restore();

    if (selected) {
      ctx.save();
      ctx.strokeStyle = 'rgba(0, 191, 255, 0.9)';
      ctx.lineWidth = 1.5;
      _traceQuadPath(ctx, visibleQuadScreen);
      ctx.stroke();
      ctx.restore();
    }
    return true;
  }

  setDiagnosticBackfaceHatchEnabled(enabled) {
    this._diagnosticBackfaceHatchEnabled = !!enabled;
  }

  setNormalColorShadingEnabled(enabled) {
    this._normalColorShadingEnabled = !!enabled;
  }

  setInvisibleEdgesVisible(enabled) {
    this._invisibleEdgesVisible = !!enabled;
  }

  setMeshTriangleOverlayMode(mode) {
    this._meshTriangleOverlayMode = mode === 'outline' ? 'outline' : 'off';
  }

  /**
   * Triangulate polygon faces and build Float32Arrays for WebGL rendering.
   * Stores face metadata for selection/identification.
   */
  _meshRenderKey(geometry, result = null) {
    if (result?.exactBodyRevisionId != null) return `rev:${result.exactBodyRevisionId}`;
    if (result?.irHash != null) return `ir:${result.irHash}`;
    if (geometry?.exactBodyRevisionId != null) return `geo-rev:${geometry.exactBodyRevisionId}`;
    if (geometry?.wasmHandleId != null) return `handle:${geometry.wasmHandleId}:${geometry.wasmHandleRevision || ''}`;
    return `shape:${geometry?.faces?.length || 0}:${geometry?.edges?.length || 0}:${geometry?.vertices?.length || 0}`;
  }

  _buildMeshFromGeometry(geometry, result = null) {
    if (!geometry) {
      this._clearMeshRenderData();
      return;
    }
    const cacheKey = this._meshRenderKey(geometry, result);
    if (this._meshRenderGeometry === geometry && this._meshRenderCacheKey === cacheKey) {
      return;
    }

    const cached = this._meshRenderCache.get(geometry);
    if (cached?.key === cacheKey) {
      Object.assign(this, cached.data);
      this._meshRenderGeometry = geometry;
      this._meshRenderCacheKey = cacheKey;
      return;
    }

    const data = buildMeshRenderData(geometry);
    this._meshRenderCache.set(geometry, { key: cacheKey, data });
    Object.assign(this, data);
    this._meshRenderGeometry = geometry;
    this._meshRenderCacheKey = cacheKey;
  }

  _clearMeshRenderData() {
    this._partBounds = null;
    this._meshRenderGeometry = null;
    this._meshRenderCacheKey = null;
    this._meshTriangles = null;
    this._meshTriangleCount = 0;
    this._problemTriangles = null;
    this._problemTriangleCount = 0;
    this._meshEdges = null;
    this._meshEdgeVertexCount = 0;
    this._meshVisualEdges = null;
    this._meshVisualEdgeVertexCount = 0;
    this._meshDashedFeatureEdges = null;
    this._meshDashedFeatureEdgeVertexCount = 0;
    this._meshTriangleOverlayEdges = null;
    this._meshTriangleOverlayEdgeVertexCount = 0;
    this._meshSilhouetteCandidates = null;
    this._meshBoundaryEdges = null;
    this._meshBoundaryEdgeVertexCount = 0;
    this._meshFaces = null;
    this._triFaceMap = null;
    this._meshEdgeSegments = null;
    this._meshEdgePaths = null;
    this._edgeToPath = null;
  }

  /**
   * Build silhouette edge candidates from face data.
   * Returns a Float32Array of smooth shared edges: [ax,ay,az, bx,by,bz, n0x,n0y,n0z, n1x,n1y,n1z] x N
   * Returns null if no candidates.
   */
  _buildSilhouetteCandidates(faces) {
    const SHARP_COS = Math.cos(15 * Math.PI / 180);
    const SAME_GROUP_MIN_COS = Math.cos(30 * Math.PI / 180);
    const precision = 5;
    const vKey = (v) => `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;
    const eKey = (a, b) => { const ka = vKey(a), kb = vKey(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };

    const edgeMap = new Map();
    for (let fi = 0; fi < faces.length; fi++) {
      const face = faces[fi];
      const verts = face.vertices;
      const n = face.normal || { x: 0, y: 0, z: 1 };
      const g = face.faceGroup != null ? face.faceGroup : fi;
      for (let i = 0; i < verts.length; i++) {
        const a = verts[i], b = verts[(i + 1) % verts.length];
        const key = eKey(a, b);
        if (!edgeMap.has(key)) edgeMap.set(key, { a, b, normals: [], groups: [] });
        const entry = edgeMap.get(key);
        entry.normals.push(n);
        entry.groups.push(g);
      }
    }

    const candidates = [];
    for (const [, info] of edgeMap) {
      if (info.normals.length >= 2) {
        const n0 = info.normals[0], n1 = info.normals[1];
        const dot = n0.x * n1.x + n0.y * n1.y + n0.z * n1.z;
        const sameGroup = info.groups[0] === info.groups[1];
        const sharpCos = sameGroup ? SAME_GROUP_MIN_COS : SHARP_COS;
        // Smooth edges only (not sharp feature, not coplanar)
        if (dot >= sharpCos && dot < 1 - 1e-6) {
          candidates.push(
            info.a.x, info.a.y, info.a.z,
            info.b.x, info.b.y, info.b.z,
            n0.x, n0.y, n0.z,
            n1.x, n1.y, n1.z
          );
        }
      }
    }
    return candidates.length > 0 ? new Float32Array(candidates) : null;
  }

  /**
   * Build wireframe data from the active editing scene (2D entities) for re-rendering
   * on top of the mesh overlay. This captures segments, circles, and arcs from the
   * current scene and transforms them to world coordinates using the sketch plane.
   * @param {Object} scene - The 2D scene with entities
   * @param {Object} plane - Sketch plane definition with origin, xAxis, yAxis
   */
  _buildActiveSceneWireframes(scene, plane, previewEntities = []) {
    const lines = [];
    const toWorld = (px, py) => ({
      x: plane.origin.x + px * plane.xAxis.x + py * plane.yAxis.x,
      y: plane.origin.y + px * plane.xAxis.y + py * plane.yAxis.y,
      z: plane.origin.z + px * plane.xAxis.z + py * plane.yAxis.z,
    });

    if (scene.segments) {
      for (const seg of scene.segments) {
        if (!seg.visible || !seg.p1 || !seg.p2) continue;
        const a = toWorld(seg.p1.x, seg.p1.y);
        const b = toWorld(seg.p2.x, seg.p2.y);
        lines.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }

    if (scene.circles) {
      for (const circle of scene.circles) {
        if (!circle.visible || !circle.center) continue;
        const numSegs = 32;
        for (let i = 0; i < numSegs; i++) {
          const a1 = (i / numSegs) * Math.PI * 2;
          const a2 = ((i + 1) / numSegs) * Math.PI * 2;
          const p1 = toWorld(
            circle.center.x + Math.cos(a1) * circle.radius,
            circle.center.y + Math.sin(a1) * circle.radius
          );
          const p2 = toWorld(
            circle.center.x + Math.cos(a2) * circle.radius,
            circle.center.y + Math.sin(a2) * circle.radius
          );
          lines.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
        }
      }
    }

    if (scene.arcs) {
      for (const arc of scene.arcs) {
        if (!arc.visible || !arc.center) continue;
        const numSegs = 16;
        let startA = arc.startAngle || 0;
        let endA = arc.endAngle || Math.PI;
        let sweep = endA - startA;
        if (sweep < 0) sweep += Math.PI * 2;
        for (let i = 0; i < numSegs; i++) {
          const a1 = startA + (i / numSegs) * sweep;
          const a2 = startA + ((i + 1) / numSegs) * sweep;
          const p1 = toWorld(
            arc.center.x + Math.cos(a1) * arc.radius,
            arc.center.y + Math.sin(a1) * arc.radius
          );
          const p2 = toWorld(
            arc.center.x + Math.cos(a2) * arc.radius,
            arc.center.y + Math.sin(a2) * arc.radius
          );
          lines.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
        }
      }
    }

    if (scene.splines) {
      for (const spl of scene.splines) {
        if (!spl.visible) continue;
        const numSegs = 32;
        const pts = spl.tessellate2D(numSegs);
        for (let i = 0; i < pts.length - 1; i++) {
          const p1 = toWorld(pts[i].x, pts[i].y);
          const p2 = toWorld(pts[i + 1].x, pts[i + 1].y);
          lines.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
        }
      }
    }

    if (scene.beziers) {
      for (const bez of scene.beziers) {
        if (!bez.visible) continue;
        const pts = bez.tessellate2D(16);
        for (let i = 0; i < pts.length - 1; i++) {
          const p1 = toWorld(pts[i].x, pts[i].y);
          const p2 = toWorld(pts[i + 1].x, pts[i + 1].y);
          lines.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
        }
      }
    }

    // Include preview entities (lines being drawn interactively but not yet committed)
    if (previewEntities && previewEntities.length > 0) {
      for (const entity of previewEntities) {
        if (!entity) continue;
        if (entity.type === 'segment' && entity.p1 && entity.p2) {
          const a = toWorld(entity.p1.x, entity.p1.y);
          const b = toWorld(entity.p2.x, entity.p2.y);
          lines.push(a.x, a.y, a.z, b.x, b.y, b.z);
        } else if (entity.type === 'circle' && entity.center) {
          const numSegs = 32;
          for (let i = 0; i < numSegs; i++) {
            const a1 = (i / numSegs) * Math.PI * 2;
            const a2 = ((i + 1) / numSegs) * Math.PI * 2;
            const p1 = toWorld(
              entity.center.x + Math.cos(a1) * entity.radius,
              entity.center.y + Math.sin(a1) * entity.radius
            );
            const p2 = toWorld(
              entity.center.x + Math.cos(a2) * entity.radius,
              entity.center.y + Math.sin(a2) * entity.radius
            );
            lines.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
          }
        } else if (entity.type === 'arc' && entity.center) {
          const numSegs = 16;
          let startA = entity.startAngle || 0;
          let endA = entity.endAngle || Math.PI;
          let sweep = endA - startA;
          if (sweep < 0) sweep += Math.PI * 2;
          for (let i = 0; i < numSegs; i++) {
            const a1 = startA + (i / numSegs) * sweep;
            const a2 = startA + ((i + 1) / numSegs) * sweep;
            const p1 = toWorld(
              entity.center.x + Math.cos(a1) * entity.radius,
              entity.center.y + Math.sin(a1) * entity.radius
            );
            const p2 = toWorld(
              entity.center.x + Math.cos(a2) * entity.radius,
              entity.center.y + Math.sin(a2) * entity.radius
            );
            lines.push(p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
          }
        } else if (entity.type === 'spline' && entity.points && entity.points.length >= 2) {
          const numSegs = 32;
          const pts = entity.tessellate2D(numSegs);
          for (let i = 0; i < pts.length - 1; i++) {
            const wp1 = toWorld(pts[i].x, pts[i].y);
            const wp2 = toWorld(pts[i + 1].x, pts[i + 1].y);
            lines.push(wp1.x, wp1.y, wp1.z, wp2.x, wp2.y, wp2.z);
          }
        } else if (entity.type === 'bezier' && entity.vertices && entity.vertices.length >= 2) {
          const pts = entity.tessellate2D(16);
          for (let i = 0; i < pts.length - 1; i++) {
            const wp1 = toWorld(pts[i].x, pts[i].y);
            const wp2 = toWorld(pts[i + 1].x, pts[i + 1].y);
            lines.push(wp1.x, wp1.y, wp1.z, wp2.x, wp2.y, wp2.z);
          }
        }
      }
    }

    if (lines.length > 0) {
      this._activeSceneEdges = new Float32Array(lines);
      this._activeSceneEdgeVertexCount = lines.length / 3;
    } else {
      this._activeSceneEdges = null;
      this._activeSceneEdgeVertexCount = 0;
    }
  }

  /**
   * Build wireframe data for sketch features so they are visible in 3D Part mode.
   * Transforms 2D sketch primitives to 3D world coordinates using their plane definitions.
   * Supports active sketch highlighting: active sketch uses normal colors, others use grey.
   * @param {Object} part - The Part object containing sketch features
   */
  _buildSketchWireframes(part) {
    this._sketchEdges = null;
    this._sketchEdgeVertexCount = 0;
    this._sketchInactiveEdges = null;
    this._sketchInactiveEdgeVertexCount = 0;
    this._sketchSelectedEdges = null;
    this._sketchSelectedEdgeVertexCount = 0;
    this._sketchFaceTriangles = null;
    this._sketchFaceTriangleCount = 0;
    this._sketchPickSegments = []; // per-feature line segments for picking
    this._sketchPickTriangles = []; // per-feature face triangles for picking
    this._partSketchImages = [];

    const sketches = part.getSketches();
    if (!sketches || sketches.length === 0) {
      this._lastPartSketchImages = [];
      return;
    }
    const liveSketchIds = new Set(sketches.map((feature) => feature?.id).filter(Boolean));
    for (const featureId of this._sketchWireframeCache.keys()) {
      if (!liveSketchIds.has(featureId)) this._sketchWireframeCache.delete(featureId);
    }

    const activeSketchId = part.getActiveSketchId ? part.getActiveSketchId() : null;
    const selectedId = this._selectedFeatureId || null;
    const activeLines = [];
    const inactiveLines = [];
    const faceVerts = []; // triangulated face fill data [x,y,z,nx,ny,nz, ...]
    const selectedLines = [];

    for (const sketchFeature of sketches) {
      if (sketchFeature.suppressed) continue;

      const isActive = sketchFeature.id === activeSketchId;
      const isSelected = sketchFeature.id === selectedId;

      // Skip the active sketch when in sketch editing mode — its live
      // geometry is rendered via _activeSceneEdges (from the 2D scene),
      // so drawing the stale feature wireframe would show deleted entities.
      if (isActive && this._sketchPlane) continue;

      // Show sketch wireframes if: visible, active, or selected in the tree
      if (!sketchFeature.visible && !isActive && !isSelected) continue;

      const sketch = sketchFeature.sketch;
      const plane = sketchFeature.plane;
      if (!sketch || !plane) continue;

      if (sketch.images && sketch.images.length > 0) {
        for (const image of sketch.images) {
          if (!image.visible) continue;
          if (!isSelected && !image.pinnedBackground) continue;
          this._partSketchImages.push({
            featureId: sketchFeature.id,
            image,
            plane,
            selected: isSelected,
          });
        }
      }

      const lines = isSelected ? selectedLines : (isActive ? activeLines : inactiveLines);
      const featureSegments = []; // collect world-space line segments for this feature
      const featureTriangles = []; // collect world-space triangles for this feature

      // Compute plane normal for z-offset (prevents z-fighting with face geometry).
      // Offset wireframes slightly along the normal so they render on top of the face.
      const nx = plane.normal ? plane.normal.x : (plane.xAxis.y * plane.yAxis.z - plane.xAxis.z * plane.yAxis.y);
      const ny = plane.normal ? plane.normal.y : (plane.xAxis.z * plane.yAxis.x - plane.xAxis.x * plane.yAxis.z);
      const nz = plane.normal ? plane.normal.z : (plane.xAxis.x * plane.yAxis.y - plane.xAxis.y * plane.yAxis.x);
      const SKETCH_WIRE_OFFSET = 0.01;

      const toWorld = (px, py) => ({
        x: plane.origin.x + px * plane.xAxis.x + py * plane.yAxis.x + nx * SKETCH_WIRE_OFFSET,
        y: plane.origin.y + px * plane.xAxis.y + py * plane.yAxis.y + ny * SKETCH_WIRE_OFFSET,
        z: plane.origin.z + px * plane.xAxis.z + py * plane.yAxis.z + nz * SKETCH_WIRE_OFFSET,
      });

      const cachedGeometry = this._getSketchWireframeCacheEntry(sketchFeature, sketch, plane, toWorld, nx, ny, nz);
      this._appendSketchWireArray(lines, cachedGeometry.lineVertices);
      this._appendSketchWireArray(featureSegments, cachedGeometry.pickSegments);

      if (featureSegments.length > 0) {
        this._sketchPickSegments.push({
          featureId: sketchFeature.id,
          segments: featureSegments,
        });
      }

      // Build triangulated face fill for closed profiles (extrudable faces)
      // so they are visually painted in feature mode just like in sketch mode.
      if (!isActive || !this._sketchPlane) {
        this._appendSketchWireArray(faceVerts, cachedGeometry.faceVertices);
        this._appendSketchWireArray(featureTriangles, cachedGeometry.pickTriangles);
      }

      if (featureTriangles.length > 0) {
        this._sketchPickTriangles.push({
          featureId: sketchFeature.id,
          triangles: featureTriangles,
        });
      }
    }

    if (activeLines.length > 0) {
      this._sketchEdges = new Float32Array(activeLines);
      this._sketchEdgeVertexCount = activeLines.length / 3;
    }

    if (inactiveLines.length > 0) {
      this._sketchInactiveEdges = new Float32Array(inactiveLines);
      this._sketchInactiveEdgeVertexCount = inactiveLines.length / 3;
    }

    if (selectedLines.length > 0) {
      this._sketchSelectedEdges = new Float32Array(selectedLines);
      this._sketchSelectedEdgeVertexCount = selectedLines.length / 3;
    }

    if (faceVerts.length > 0) {
      this._sketchFaceTriangles = new Float32Array(faceVerts);
      this._sketchFaceTriangleCount = faceVerts.length / 6;
    }
    this._lastPartSketchImages = this._partSketchImages.slice();
  }

  /**
   * Render pre-built mesh data directly via WebGL (called after WASM render pass).
   */
  _renderMeshOverlay() {
    const gl = this.executor.gl;
    const exec = this.executor;
    const hasMesh = this._meshTriangles && this._meshTriangleCount > 0;
    const hasGhost = this._ghostTriangles && this._ghostTriangleCount > 0;
    const hasArrow = this._extrudeArrowLines && this._extrudeArrowVertexCount > 0;
    const hasSketchEdges = this._sketchEdges && this._sketchEdgeVertexCount > 0;
    const hasInactiveEdges = this._sketchInactiveEdges && this._sketchInactiveEdgeVertexCount > 0;
    const hasSelectedEdges = this._sketchSelectedEdges && this._sketchSelectedEdgeVertexCount > 0;
    const hasActiveScene = this._activeSceneEdges && this._activeSceneEdgeVertexCount > 0;
    const hasSketchFaces = this._sketchFaceTriangles && this._sketchFaceTriangleCount > 0;
    if (!hasMesh && !hasGhost && !hasArrow && !hasSketchEdges && !hasInactiveEdges && !hasSelectedEdges && !hasActiveScene && !hasSketchFaces) return;

    // Compute the same MVP as the WASM camera
    const mvp = this._computeMVP();
    if (!mvp) return;

    // Enable depth testing and backface culling for correct solid rendering
    exec.setDepthTest(true);
    exec.setDepthFunc(gl.LEQUAL);
    exec.setCullFace(true);
    gl.cullFace(gl.BACK);

    if (hasMesh) {
      renderBaseMeshOverlay(exec, {
        meshTriangles: this._meshTriangles,
        meshTriangleCount: this._meshTriangleCount,
        meshVisualEdges: this._meshVisualEdges,
        meshVisualEdgeVertexCount: this._meshVisualEdgeVertexCount,
        meshDashedFeatureEdges: this._meshDashedFeatureEdges,
        meshDashedFeatureEdgeVertexCount: this._meshDashedFeatureEdgeVertexCount,
        meshTriangleOverlayEdges: this._meshTriangleOverlayEdges,
        meshTriangleOverlayEdgeVertexCount: this._meshTriangleOverlayEdgeVertexCount,
        meshEdges: this._meshEdges,
        meshEdgeVertexCount: this._meshEdgeVertexCount,
        meshSilhouetteCandidates: this._meshSilhouetteCandidates,
        meshBoundaryEdges: this._meshBoundaryEdges,
        meshBoundaryEdgeVertexCount: this._meshBoundaryEdgeVertexCount,
        orbitState: {
          theta: this._orbitTheta,
          phi: this._orbitPhi,
          radius: this._orbitRadius,
          target: this._orbitTarget,
        },
        mvp,
        showInvisibleEdges: this._invisibleEdgesVisible,
        meshTriangleOverlayMode: this._meshTriangleOverlayMode,
        normalColorShading: this._normalColorShadingEnabled,
      });

      if (this._diagnosticBackfaceHatchEnabled) {
        exec.setBlend(true);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        exec.setCullFace(true);
        gl.cullFace(gl.FRONT);
        exec.setDepthFunc(gl.LEQUAL);

        gl.useProgram(exec.programs[2]);
        gl.uniformMatrix4fv(exec.uniforms[2].uMVP, false, mvp);

        gl.bindVertexArray(exec.vaoSolid);
        gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this._meshTriangles, gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.TRIANGLES, 0, this._meshTriangleCount);
        gl.bindVertexArray(null);

        exec.setBlend(false);
        exec.setCullFace(true);
        gl.cullFace(gl.BACK);
      }

      // Draw selected face highlight (highlights entire face group for each selected face)
      if (this._selectedFaceIndices.size > 0 && this._meshFaces && this._triFaceMap) {
        // Collect all face groups from selected faces
        const selGroups = new Set();
        for (const fi of this._selectedFaceIndices) {
          const selMeta = this._meshFaces[fi];
          selGroups.add(selMeta ? selMeta.faceGroup : fi);
        }
        const highlightVerts = _buildFaceGroupHighlightVertices(
          this._meshTriangles,
          this._meshTriangleCount,
          this._meshFaces,
          this._triFaceMap,
          selGroups,
        );
        _drawFaceHighlightOverlay(gl, exec, mvp, highlightVerts, [0.2, 0.6, 1.0, 0.35]);
      }

      // Draw selected edge highlights (bright cyan)
      if (this._selectedEdgeIndices.size > 0 && this._meshEdgeSegments) {
        const selEdgeVerts = [];
        for (const idx of this._selectedEdgeIndices) {
          const seg = this._meshEdgeSegments[idx];
          if (!seg) continue;
          _appendEdgePolylineVertices(selEdgeVerts, seg);
        }
        if (selEdgeVerts.length > 0) {
          const selEdgeData = new Float32Array(selEdgeVerts);
          gl.useProgram(exec.programs[1]);
          gl.uniformMatrix4fv(exec.uniforms[1].uMVP, false, mvp);
          gl.uniform4f(exec.uniforms[1].uColor, 0.0, 0.8, 1.0, 1.0);
          gl.lineWidth(1.0);
          exec.setDepthTest(false);

          gl.bindVertexArray(exec.vaoLine);
          gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
          gl.bufferData(gl.ARRAY_BUFFER, selEdgeData, gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.LINES, 0, selEdgeVerts.length / 3);
          gl.bindVertexArray(null);
          exec.setDepthTest(true);
        }
      }

      // Draw hovered edge highlight (yellow, not yet selected)
      if (this._hoveredEdgeIndex >= 0 && this._meshEdgeSegments) {
        const hovVerts = [];
        // Resolve full path for the hovered edge
        const pathIdx = this._edgeToPath ? this._edgeToPath.get(this._hoveredEdgeIndex) : undefined;
        if (pathIdx !== undefined && this._meshEdgePaths) {
          for (const i of this._meshEdgePaths[pathIdx].edgeIndices) {
            const seg = this._meshEdgeSegments[i];
            if (!seg) continue;
            _appendEdgePolylineVertices(hovVerts, seg);
          }
        } else {
          const seg = this._meshEdgeSegments[this._hoveredEdgeIndex];
          if (seg) {
            _appendEdgePolylineVertices(hovVerts, seg);
          }
        }
        if (hovVerts.length > 0) {
          const hovData = new Float32Array(hovVerts);
          gl.useProgram(exec.programs[1]);
          gl.uniformMatrix4fv(exec.uniforms[1].uMVP, false, mvp);
          // Use a lighter cyan when hovering over an already-selected edge, yellow otherwise
          if (this._selectedEdgeIndices.has(this._hoveredEdgeIndex)) {
            gl.uniform4f(exec.uniforms[1].uColor, 0.4, 0.9, 1.0, 1.0);
          } else {
            gl.uniform4f(exec.uniforms[1].uColor, 1.0, 0.9, 0.0, 1.0);
          }
          gl.lineWidth(1.0);
          exec.setDepthTest(false);

          gl.bindVertexArray(exec.vaoLine);
          gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
          gl.bufferData(gl.ARRAY_BUFFER, hovData, gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.LINES, 0, hovVerts.length / 3);
          gl.bindVertexArray(null);
          exec.setDepthTest(true);
        }
      }

      // Draw hovered face highlight (semi-transparent yellow) — highlights entire feature face group
      if (this._hoveredFaceIndex >= 0 && this._meshFaces && this._triFaceMap) {
        const hovMeta = this._meshFaces[this._hoveredFaceIndex];
        const hovGroup = hovMeta ? hovMeta.faceGroup : this._hoveredFaceIndex;
        const hovFaceVerts = _buildFaceGroupHighlightVertices(
          this._meshTriangles,
          this._meshTriangleCount,
          this._meshFaces,
          this._triFaceMap,
          new Set([hovGroup]),
        );
        if (hovFaceVerts.length > 0) {
          const hovGroupSelected = (() => {
            for (const fi of this._selectedFaceIndices) {
              const selMeta = this._meshFaces[fi];
              if ((selMeta ? selMeta.faceGroup : fi) === hovGroup) return true;
            }
            return false;
          })();
          _drawFaceHighlightOverlay(
            gl,
            exec,
            mvp,
            hovFaceVerts,
            hovGroupSelected ? [0.4, 0.75, 1.0, 0.45] : [1.0, 0.9, 0.0, 0.2],
          );
        }
      }

    }

    // Draw ghost preview (semi-transparent extrude preview)
    if (hasGhost) {
      exec.setDepthTest(true);
      exec.setDepthFunc(gl.LEQUAL);
      exec.setBlend(true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      exec.setCullFace(false);

      // Ghost solid triangles
      exec.setPolygonOffset(true);
      gl.polygonOffset(1.0, 1.0);

      gl.useProgram(exec.programs[0]);
      gl.uniformMatrix4fv(exec.uniforms[0].uMVP, false, mvp);
      gl.uniform4f(exec.uniforms[0].uColor, 0.4, 0.7, 1.0, 0.25);

      gl.bindVertexArray(exec.vaoSolid);
      gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this._ghostTriangles, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, this._ghostTriangleCount);
      gl.bindVertexArray(null);

      exec.setPolygonOffset(false);

      // Ghost wireframe edges (drawn through all geometry)
      if (this._ghostEdges && this._ghostEdgeVertexCount > 0) {
        exec.setDepthTest(false);
        gl.useProgram(exec.programs[1]);
        gl.uniformMatrix4fv(exec.uniforms[1].uMVP, false, mvp);
        gl.uniform4f(exec.uniforms[1].uColor, 0.4, 0.7, 1.0, 1.0);
        gl.lineWidth(1.0);

        gl.bindVertexArray(exec.vaoLine);
        gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this._ghostEdges, gl.DYNAMIC_DRAW);
        gl.drawArrays(gl.LINES, 0, this._ghostEdgeVertexCount);
        gl.bindVertexArray(null);
      }

      // Ghost silhouette edges (view-dependent outline on curved surfaces)
      if (this._ghostSilhouetteCandidates) {
        const ghostSilData = computeSilhouetteEdges(this._ghostSilhouetteCandidates, {
          theta: this._orbitTheta,
          phi: this._orbitPhi,
          radius: this._orbitRadius,
          target: this._orbitTarget,
        });
        if (ghostSilData) {
          exec.setDepthTest(false);
          gl.useProgram(exec.programs[1]);
          gl.uniformMatrix4fv(exec.uniforms[1].uMVP, false, mvp);
          gl.uniform4f(exec.uniforms[1].uColor, 0.4, 0.7, 1.0, 1.0);
          gl.lineWidth(1.0);

          gl.bindVertexArray(exec.vaoLine);
          gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
          gl.bufferData(gl.ARRAY_BUFFER, ghostSilData, gl.DYNAMIC_DRAW);
          gl.drawArrays(gl.LINES, 0, ghostSilData.length / 3);
          gl.bindVertexArray(null);
        }
      }

      exec.setDepthTest(true);

      exec.setBlend(false);
      exec.setCullFace(true);
      gl.cullFace(gl.BACK);
    }

    // Draw extrude handle arrow (always visible, drawn on top)
    if (hasArrow) {
      exec.setDepthTest(false);
      gl.useProgram(exec.programs[1]);
      gl.uniformMatrix4fv(exec.uniforms[1].uMVP, false, mvp);
      if (this._extrudeArrowHovered) {
        gl.uniform4f(exec.uniforms[1].uColor, 1.0, 0.75, 0.1, 1.0);
      } else {
        gl.uniform4f(exec.uniforms[1].uColor, 1.0, 0.6, 0.0, 0.9);
      }
      gl.lineWidth(1.0);
      gl.bindVertexArray(exec.vaoLine);
      gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this._extrudeArrowLines, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, this._extrudeArrowVertexCount);
      gl.bindVertexArray(null);
      exec.setDepthTest(true);
    }

    // Draw sketch face fills (semi-transparent extrudable profile faces)
    if (hasSketchFaces) {
      exec.setDepthTest(true);
      exec.setDepthFunc(gl.LEQUAL);
      exec.setCullFace(false);
      exec.setDepthWrite(false);
      exec.setBlend(true);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(exec.programs[0]);
      gl.uniformMatrix4fv(exec.uniforms[0].uMVP, false, mvp);
      gl.uniform4f(exec.uniforms[0].uColor, 0.4, 0.7, 1.0, 0.12);

      gl.bindVertexArray(exec.vaoSolid);
      gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this._sketchFaceTriangles, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, this._sketchFaceTriangleCount);
      gl.bindVertexArray(null);
      exec.setDepthWrite(true);
      exec.setBlend(false);
    }

    // Draw sketch wireframes (visible sketch primitives in 3D)
    // Wireframe vertices are offset slightly along the sketch plane normal to prevent
    // z-fighting. Keep depth test enabled so sketches are properly occluded when
    // viewed from behind the face they lie on.
    if (hasSketchEdges) {
      exec.setDepthTest(true);
      exec.setDepthFunc(gl.LEQUAL);
      exec.setCullFace(false);
      gl.useProgram(exec.programs[1]);
      gl.uniformMatrix4fv(exec.uniforms[1].uMVP, false, mvp);
      gl.uniform4f(exec.uniforms[1].uColor, 0.4, 0.7, 1.0, 1.0);
      gl.lineWidth(1.0);

      gl.bindVertexArray(exec.vaoLine);
      gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this._sketchEdges, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, this._sketchEdgeVertexCount);
      gl.bindVertexArray(null);
    }

    // Draw inactive sketch wireframes in grey (non-active sketches when editing one)
    if (hasInactiveEdges) {
      exec.setDepthTest(true);
      exec.setDepthFunc(gl.LEQUAL);
      exec.setCullFace(false);
      gl.useProgram(exec.programs[1]);
      gl.uniformMatrix4fv(exec.uniforms[1].uMVP, false, mvp);
      gl.uniform4f(exec.uniforms[1].uColor, 0, 0, 0, 1.0);
      gl.lineWidth(1.0);

      gl.bindVertexArray(exec.vaoLine);
      gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this._sketchInactiveEdges, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, this._sketchInactiveEdgeVertexCount);
      gl.bindVertexArray(null);
    }

    // Draw selected sketch wireframes in highlight color (when sketch selected in tree)
    if (hasSelectedEdges) {
      exec.setDepthTest(true);
      exec.setDepthFunc(gl.LEQUAL);
      exec.setCullFace(false);
      gl.useProgram(exec.programs[1]);
      gl.uniformMatrix4fv(exec.uniforms[1].uMVP, false, mvp);
      gl.uniform4f(exec.uniforms[1].uColor, 0.2, 0.6, 1.0, 1.0); // bright blue highlight
      gl.lineWidth(1.0);

      gl.bindVertexArray(exec.vaoLine);
      gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this._sketchSelectedEdges, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, this._sketchSelectedEdgeVertexCount);
      gl.bindVertexArray(null);
    }

    // Draw active scene wireframes on top of mesh (for sketch-on-face editing mode)
    // These are the live 2D entities being drawn/edited. The WASM render pass draws
    // them first, but the mesh overlay covers them. Re-render here with depth test
    // disabled so they always appear on top of the solid face.
    if (hasActiveScene) {
      exec.setDepthTest(false);
      exec.setCullFace(false);
      gl.useProgram(exec.programs[1]);
      gl.uniformMatrix4fv(exec.uniforms[1].uMVP, false, mvp);
      gl.uniform4f(exec.uniforms[1].uColor, 0.612, 0.863, 0.996, 1.0); // #9CDCFE sketch color
      gl.lineWidth(1.0);

      gl.bindVertexArray(exec.vaoLine);
      gl.bindBuffer(gl.ARRAY_BUFFER, exec.vbo);
      gl.bufferData(gl.ARRAY_BUFFER, this._activeSceneEdges, gl.DYNAMIC_DRAW);
      gl.drawArrays(gl.LINES, 0, this._activeSceneEdgeVertexCount);
      gl.bindVertexArray(null);
      exec.setDepthTest(true);
    }

    // Restore WebGL state expected by the WASM executor on the next frame
    // (origin planes depend on blending for transparency).
    exec.setBlend(true);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    exec.setDepthFunc(gl.LESS);
    exec.setCullFace(false);
  }

  /**
   * Compute MVP matrix matching the current WASM perspective camera.
   */
  _computeMVP() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w === 0 || h === 0) return null;

    const aspect = w / h;
    const t = this._orbitTarget;
    const theta = this._orbitTheta;
    const phi = this._orbitPhi;
    const r = _clampOrbitRadius(this._orbitRadius);
    const { near, far } = _cameraClipRange(r);

    const camX = t.x + r * Math.sin(phi) * Math.cos(theta);
    const camY = t.y + r * Math.sin(phi) * Math.sin(theta);
    const camZ = t.z + r * Math.cos(phi);

    // View matrix (lookAt with Z-up)
    const view = this._mat4LookAt(camX, camY, camZ, t.x, t.y, t.z, 0, 0, 1);
    if (!view) return null;

    // Projection matrix: orthographic when FOV is 0 or ortho3D is forced,
    // otherwise perspective with the configured FOV.
    let proj;
    if (this._fovDegrees <= 0 || (this._ortho3D && this._orthoBounds)) {
      // Orthographic: map orbit radius to view extent
      const halfH = r * 0.5;
      const halfW = halfH * aspect;
      if (this._ortho3D && this._orthoBounds) {
        const b = this._orthoBounds;
        proj = this._mat4Ortho(b.left, b.right, b.bottom, b.top, near, far);
      } else {
        proj = this._mat4Ortho(-halfW, halfW, -halfH, halfH, near, far);
      }
    } else {
      proj = this._mat4Perspective(this._fov, aspect, near, far);
    }

    // MVP = proj * view (column-major multiplication)
    return this._mat4Multiply(proj, view);
  }

  /**
   * Compute a world-space pick ray from screen coordinates.
   * Works for both orthographic and perspective cameras. For perspective,
   * the far NDC plane maps to projective infinity (farW.w → 0); in that case
   * farW.xyz is used directly as the unnormalized ray direction.
   * @param {number} screenX - client X coordinate
   * @param {number} screenY - client Y coordinate
   * @returns {{origin:{x,y,z}, dir:{x,y,z}, mvp:Float32Array, ndcX:number, ndcY:number, rect:DOMRect}|null}
   */
  _computePickRay(screenX, screenY) {
    const mvp = this._computeMVP();
    if (!mvp) return null;
    const invMVP = this._mat4Invert(mvp);
    if (!invMVP) return null;

    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((screenY - rect.top) / rect.height) * 2 + 1;

    // Near point (NDC z = -1) always has finite w for any valid projection.
    const nearW = this._mat4TransformVec4(invMVP, ndcX, ndcY, -1, 1);
    if (Math.abs(nearW.w) < 1e-10) return null;
    const origin = { x: nearW.x / nearW.w, y: nearW.y / nearW.w, z: nearW.z / nearW.w };

    // Far point (NDC z = +1). For a perspective projection the far plane sits at
    // projective infinity so farW.w → 0. In that case farW.xyz is the direction.
    const farW = this._mat4TransformVec4(invMVP, ndcX, ndcY, 1, 1);
    let dir;
    if (Math.abs(farW.w) < 1e-10) {
      dir = { x: farW.x, y: farW.y, z: farW.z };
    } else {
      const farPt = { x: farW.x / farW.w, y: farW.y / farW.w, z: farW.z / farW.w };
      dir = { x: farPt.x - origin.x, y: farPt.y - origin.y, z: farPt.z - origin.z };
    }

    const dirLen = Math.sqrt(dir.x * dir.x + dir.y * dir.y + dir.z * dir.z);
    if (dirLen < 1e-10) return null;
    dir.x /= dirLen; dir.y /= dirLen; dir.z /= dirLen;

    return { origin, dir, mvp, ndcX, ndcY, rect };
  }

  _mat4Perspective(fov, aspect, near, far) {
    const f = 1.0 / Math.tan(fov / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  }

  _mat4Ortho(left, right, bottom, top, near, far) {
    const lr = 1 / (left - right);
    const bt = 1 / (bottom - top);
    const nf = 1 / (near - far);
    return new Float32Array([
      -2 * lr, 0, 0, 0,
      0, -2 * bt, 0, 0,
      0, 0, 2 * nf, 0,
      (left + right) * lr,
      (top + bottom) * bt,
      (far + near) * nf,
      1,
    ]);
  }

  _mat4LookAt(ex, ey, ez, cx, cy, cz, ux, uy, uz) {
    let fx = cx - ex, fy = cy - ey, fz = cz - ez;
    let len = Math.sqrt(fx * fx + fy * fy + fz * fz);
    if (len < 1e-10) return null;
    fx /= len; fy /= len; fz /= len;

    // s = f × up
    let sx = fy * uz - fz * uy, sy = fz * ux - fx * uz, sz = fx * uy - fy * ux;
    len = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (len < 1e-10) {
      // Forward parallel to up — use alternative up vector
      const ax = Math.abs(fx) < 0.9 ? 1 : 0, ay = Math.abs(fx) < 0.9 ? 0 : 1;
      sx = fy * 0 - fz * ay; sy = fz * ax - fx * 0; sz = fx * ay - fy * ax;
      len = Math.sqrt(sx * sx + sy * sy + sz * sz);
      if (len < 1e-10) return null;
    }
    sx /= len; sy /= len; sz /= len;

    // u = s × f
    const ux2 = sy * fz - sz * fy, uy2 = sz * fx - sx * fz, uz2 = sx * fy - sy * fx;

    return new Float32Array([
      sx, ux2, -fx, 0,
      sy, uy2, -fy, 0,
      sz, uz2, -fz, 0,
      -(sx * ex + sy * ey + sz * ez),
      -(ux2 * ex + uy2 * ey + uz2 * ez),
      (fx * ex + fy * ey + fz * ez),
      1,
    ]);
  }

  _mat4Multiply(a, b) {
    const out = new Float32Array(16);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        out[j * 4 + i] =
          a[0 * 4 + i] * b[j * 4 + 0] +
          a[1 * 4 + i] * b[j * 4 + 1] +
          a[2 * 4 + i] * b[j * 4 + 2] +
          a[3 * 4 + i] * b[j * 4 + 3];
      }
    }
    return out;
  }

  clearPartGeometry() {
    if (!this._ready) return;
    for (const id of this._partNodes) {
      this.wasm.removeNode(id);
    }
    this._partNodes = [];
    this._clearMeshRenderData();
    this._sketchEdges = null;
    this._sketchEdgeVertexCount = 0;
    this._sketchInactiveEdges = null;
    this._sketchInactiveEdgeVertexCount = 0;
    this._sketchSelectedEdges = null;
    this._sketchSelectedEdgeVertexCount = 0;
    this._sketchFaceTriangles = null;
    this._sketchFaceTriangleCount = 0;
    this._sketchPickSegments = [];
    this._sketchPickTriangles = [];
    this._partSketchImages = [];
    this._lastPartSketchImages = [];
    this._renderedPart = null;
    this._activeSceneEdges = null;
    this._activeSceneEdgeVertexCount = 0;
    this._selectedFaceIndices.clear();
    this._selectedEdgeIndices.clear();
    this._hoveredEdgeIndex = -1;
    this._hoveredFaceIndex = -1;
    this.clearGhostPreview();
    this.clearExtrudeArrow();
  }

  /**
   * Set ghost preview geometry (semi-transparent extrude preview).
   * @param {Object} geometry - Geometry with faces array (same format as CSG output)
   */
  setGhostPreview(geometry) {
    if (!geometry || !geometry.faces || geometry.faces.length === 0) {
      this.clearGhostPreview();
      return;
    }

    const faces = geometry.faces;

    // Build triangles (same as _buildMeshFromGeometry but into ghost buffers)
    let triCount = 0;
    for (const face of faces) {
      if (face.vertices.length >= 3) triCount += face.vertices.length - 2;
    }

    const triData = new Float32Array(triCount * 3 * 6);
    let ti = 0;
    for (const face of faces) {
      const verts = face.vertices;
      const n = face.normal || { x: 0, y: 0, z: 1 };
      if (verts.length < 3) continue;
      for (let i = 1; i < verts.length - 1; i++) {
        const v0 = verts[0], v1 = verts[i], v2 = verts[i + 1];
        triData[ti++] = v0.x; triData[ti++] = v0.y; triData[ti++] = v0.z;
        triData[ti++] = n.x;  triData[ti++] = n.y;  triData[ti++] = n.z;
        triData[ti++] = v1.x; triData[ti++] = v1.y; triData[ti++] = v1.z;
        triData[ti++] = n.x;  triData[ti++] = n.y;  triData[ti++] = n.z;
        triData[ti++] = v2.x; triData[ti++] = v2.y; triData[ti++] = v2.z;
        triData[ti++] = n.x;  triData[ti++] = n.y;  triData[ti++] = n.z;
      }
    }
    this._ghostTriangles = triData;
    this._ghostTriangleCount = triCount * 3;

    // Build edges
    const SHARP_COS = Math.cos(15 * Math.PI / 180);
    const edgeMap = new Map();
    const precision = 5;
    const vKey = (v) => `${v.x.toFixed(precision)},${v.y.toFixed(precision)},${v.z.toFixed(precision)}`;
    const eKey = (a, b) => { const ka = vKey(a), kb = vKey(b); return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`; };

    for (const face of faces) {
      const v = face.vertices;
      const n = face.normal || { x: 0, y: 0, z: 1 };
      for (let i = 0; i < v.length; i++) {
        const a = v[i], b = v[(i + 1) % v.length];
        const key = eKey(a, b);
        if (!edgeMap.has(key)) edgeMap.set(key, { a, b, normals: [] });
        edgeMap.get(key).normals.push(n);
      }
    }

    const featureEdges = [];
    for (const [, info] of edgeMap) {
      if (info.normals.length === 1) { featureEdges.push(info); }
      else if (info.normals.length >= 2) {
        const n0 = info.normals[0];
        for (let i = 1; i < info.normals.length; i++) {
          const dot = n0.x * info.normals[i].x + n0.y * info.normals[i].y + n0.z * info.normals[i].z;
          if (dot < SHARP_COS) { featureEdges.push(info); break; }
        }
      }
    }

    const edgeData = new Float32Array(featureEdges.length * 2 * 3);
    let ei = 0;
    for (const e of featureEdges) {
      edgeData[ei++] = e.a.x; edgeData[ei++] = e.a.y; edgeData[ei++] = e.a.z;
      edgeData[ei++] = e.b.x; edgeData[ei++] = e.b.y; edgeData[ei++] = e.b.z;
    }
    this._ghostEdges = edgeData;
    this._ghostEdgeVertexCount = featureEdges.length * 2;

    // Build silhouette candidates: smooth shared edges (non-feature, non-coplanar)
    // Store as flat array: [ax,ay,az, bx,by,bz, n0x,n0y,n0z, n1x,n1y,n1z] per candidate (12 floats)
    const silCandidates = [];
    for (const [, info] of edgeMap) {
      if (info.normals.length >= 2) {
        const n0 = info.normals[0], n1 = info.normals[1];
        const dot = n0.x * n1.x + n0.y * n1.y + n0.z * n1.z;
        if (dot >= SHARP_COS && dot < 1 - 1e-6) {
          silCandidates.push(
            info.a.x, info.a.y, info.a.z,
            info.b.x, info.b.y, info.b.z,
            n0.x, n0.y, n0.z,
            n1.x, n1.y, n1.z
          );
        }
      }
    }
    this._ghostSilhouetteCandidates = silCandidates.length > 0 ? new Float32Array(silCandidates) : null;

    this._ghostVisualEdges = null;
    this._ghostVisualEdgeVertexCount = 0;
  }

  /**
   * Clear ghost preview geometry.
   */
  clearGhostPreview() {
    this._ghostTriangles = null;
    this._ghostTriangleCount = 0;
    this._ghostEdges = null;
    this._ghostEdgeVertexCount = 0;
    this._ghostVisualEdges = null;
    this._ghostVisualEdgeVertexCount = 0;
    this._ghostSilhouetteCandidates = null;
  }

  /**
   * Set extrude handle arrow geometry (shaft + arrowhead lines).
   */
  setExtrudeArrow(origin, tip, hovered = false) {
    if (!origin || !tip) { this.clearExtrudeArrow(); return; }
    const dx = tip.x - origin.x, dy = tip.y - origin.y, dz = tip.z - origin.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 0.001) { this.clearExtrudeArrow(); return; }
    this._extrudeArrowHovered = hovered;
    const dir = { x: dx / len, y: dy / len, z: dz / len };
    const headLen = Math.min(len * 0.12, 1.5);
    const headR = headLen * (hovered ? 0.55 : 0.35);

    const ref = Math.abs(dir.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
    const p1 = { x: dir.y * ref.z - dir.z * ref.y, y: dir.z * ref.x - dir.x * ref.z, z: dir.x * ref.y - dir.y * ref.x };
    const p1l = Math.sqrt(p1.x * p1.x + p1.y * p1.y + p1.z * p1.z);
    p1.x /= p1l; p1.y /= p1l; p1.z /= p1l;
    const p2 = { x: dir.y * p1.z - dir.z * p1.y, y: dir.z * p1.x - dir.x * p1.z, z: dir.x * p1.y - dir.y * p1.x };
    const base = { x: tip.x - dir.x * headLen, y: tip.y - dir.y * headLen, z: tip.z - dir.z * headLen };

    // Cone spokes (4 normal, 8 hovered for a fuller arrowhead)
    const spokes = hovered ? 8 : 4;
    const lineCount = (hovered ? 3 : 1) + spokes; // shaft lines + cone lines
    const data = new Float32Array(lineCount * 2 * 3);
    let i = 0;

    // Shaft line(s)
    data[i++] = origin.x; data[i++] = origin.y; data[i++] = origin.z;
    data[i++] = tip.x;    data[i++] = tip.y;    data[i++] = tip.z;
    if (hovered) {
      // Two parallel offset lines for visual thickness
      const off = 0.02;
      data[i++] = origin.x + p1.x * off; data[i++] = origin.y + p1.y * off; data[i++] = origin.z + p1.z * off;
      data[i++] = tip.x + p1.x * off;    data[i++] = tip.y + p1.y * off;    data[i++] = tip.z + p1.z * off;
      data[i++] = origin.x - p1.x * off; data[i++] = origin.y - p1.y * off; data[i++] = origin.z - p1.z * off;
      data[i++] = tip.x - p1.x * off;    data[i++] = tip.y - p1.y * off;    data[i++] = tip.z - p1.z * off;
    }

    // Cone lines
    for (let s = 0; s < spokes; s++) {
      const angle = (s / spokes) * Math.PI * 2;
      const cs = Math.cos(angle), sn = Math.sin(angle);
      const cx = base.x + (p1.x * cs + p2.x * sn) * headR;
      const cy = base.y + (p1.y * cs + p2.y * sn) * headR;
      const cz = base.z + (p1.z * cs + p2.z * sn) * headR;
      data[i++] = tip.x; data[i++] = tip.y; data[i++] = tip.z;
      data[i++] = cx;    data[i++] = cy;    data[i++] = cz;
    }

    this._extrudeArrowLines = data;
    this._extrudeArrowVertexCount = lineCount * 2;
  }

  clearExtrudeArrow() {
    this._extrudeArrowLines = null;
    this._extrudeArrowVertexCount = 0;
    this._extrudeArrowHovered = false;
  }

  /**
   * Get face metadata for a given face index.
   * @param {number} faceIndex - Index into the faces array
   * @returns {Object|null} Face metadata (faceType, normal, shared)
   */
  getFaceInfo(faceIndex) {
    if (!this._meshFaces || faceIndex < 0 || faceIndex >= this._meshFaces.length) return null;
    return this._meshFaces[faceIndex];
  }

  /**
   * Get all face metadata.
   * @returns {Array|null} Array of face metadata objects
   */
  getAllFaces() {
    return this._meshFaces || null;
  }

  /**
   * Get raw mesh triangle data for export.
   * @returns {{triangles: Float32Array, vertexCount: number}|null}
   */
  getMeshTriangles() {
    if (!this._meshTriangles || this._meshTriangleCount <= 0) return null;
    return { triangles: this._meshTriangles, vertexCount: this._meshTriangleCount };
  }

  /**
   * Check whether part mesh geometry has been built.
   * @returns {boolean} True if mesh triangles exist
   */
  hasGeometry() {
    return this._meshTriangles != null && this._meshTriangleCount > 0;
  }

  clearGeometry() {
    this.clearPartGeometry();
    if (this._ready) {
      this.wasm.clearScene();
    }
  }

  fitToView() {
    if (!this._ready) return;
    if (this.mode === '3d') {
      const fit = computeFitViewState(this._partBounds, 25);
      this._orbitTarget = fit.target;
      this._orbitRadius = _clampOrbitRadius(fit.radius);
      this.wasm.setGridSize(fit.gridSize, 20);
      this.wasm.setAxesSize(fit.axesSize);
      this._orbitTheta = Math.PI / 4;
      this._orbitPhi = Math.PI / 3;
      this._orbitDirty = true;
      this._applyOrbitCamera();
    }
  }

  /**
   * Reset to the "Home" camera: isometric perspective view, zoom to extents.
   * Restores default FOV (45°) + perspective projection + iso angles.
   */
  homeCamera() {
    this.setFOV(45);
    this.setOrtho3D(false);
    this.fitToView();
  }

  /**
   * Convert screen coordinates to world coordinates on the XY plane.
   */
  screenToWorld(screenX, screenY) {
    const rect = this.canvas.getBoundingClientRect();
    const ndcX = ((screenX - rect.left) / rect.width) * 2 - 1;
    const ndcY = -((screenY - rect.top) / rect.height) * 2 + 1;

    const bounds = this._orthoBounds;
    const wx = bounds.left + (ndcX + 1) * 0.5 * (bounds.right - bounds.left);
    const wy = bounds.bottom + (ndcY + 1) * 0.5 * (bounds.top - bounds.bottom);
    return { x: wx, y: wy };
  }

  /**
   * Capture the current 3D viewport as a PNG data URL.
   * Composites the WebGL canvas with the 2D overlay canvas.
   * @returns {string} PNG data URL
   */
  captureImage() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    const dest = document.createElement('canvas');
    dest.width = w;
    dest.height = h;
    const ctx = dest.getContext('2d');
    ctx.drawImage(this.canvas, 0, 0);
    ctx.drawImage(this.overlayCanvas, 0, 0, w, h);
    return dest.toDataURL('image/png');
  }

  dispose() {
    if (this._animationId) {
      cancelAnimationFrame(this._animationId);
    }
    this.clearGeometry();
    this.executor.dispose();
    if (this._resizeHandler) {
      window.removeEventListener('resize', this._resizeHandler);
    }
    if (this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }
    if (this.overlayCanvas.parentNode) {
      this.overlayCanvas.parentNode.removeChild(this.overlayCanvas);
    }
  }
}

// ---------------------------------------------------------------------------
// Fully-constrained DOF analysis (ported from legacy renderer.js)
// Propagates constraints from fixed points to determine which points and
// entities are fully constrained (colored blue #569CD6 in the legacy UI).
// ---------------------------------------------------------------------------

const FULLY_CONSTRAINED_COLOR = [0.337, 0.612, 0.839, 1.0]; // #569CD6

function _computeFullyConstrained(scene) {
  const ps = new Map();
  for (const pt of scene.points) {
    ps.set(pt, {
      xLock: !!pt.fixed,
      yLock: !!pt.fixed,
      radials: new Set(),
      onFCLine: false,
    });
  }
  // Include reference entities (origin, axis endpoints) as fully-constrained
  if (scene._originPoint) {
    for (const rp of [scene._originPoint, scene._xAxisLine && scene._xAxisLine.p2, scene._yAxisLine && scene._yAxisLine.p2]) {
      if (rp && !ps.has(rp)) ps.set(rp, { xLock: true, yLock: true, radials: new Set(), onFCLine: false });
    }
  }

  const ss = new Map();
  for (const seg of scene.segments) {
    ss.set(seg, { dirKnown: false, lenKnown: false });
  }
  if (scene._xAxisLine && !ss.has(scene._xAxisLine)) ss.set(scene._xAxisLine, { dirKnown: true, lenKnown: true });
  if (scene._yAxisLine && !ss.has(scene._yAxisLine)) ss.set(scene._yAxisLine, { dirKnown: true, lenKnown: true });

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

  let changed = true;
  let safety = 100; // Max iterations to prevent infinite loops in cyclic constraint graphs
  while (changed && safety-- > 0) {
    changed = false;

    for (const c of scene.constraints) {
      switch (c.type) {
        case 'fixed': {
          const sp = ps.get(c.pt);
          if (sp && markFC(sp)) changed = true;
          break;
        }
        case 'parallel':
        case 'perpendicular': {
          const siA = ss.get(c.segA), siB = ss.get(c.segB);
          if (siA && siB) {
            if (siA.dirKnown && !siB.dirKnown) { siB.dirKnown = true; changed = true; }
            if (siB.dirKnown && !siA.dirKnown) { siA.dirKnown = true; changed = true; }
          }
          break;
        }
        case 'horizontal':
        case 'vertical': {
          const si = ss.get(c.seg);
          if (si && !si.dirKnown) { si.dirKnown = true; changed = true; }
          break;
        }
        case 'coincident': {
          const sa = ps.get(c.ptA), sb = ps.get(c.ptB);
          if (sa && sb) {
            if (isFC(sa) && !isFC(sb) && markFC(sb)) changed = true;
            if (isFC(sb) && !isFC(sa) && markFC(sa)) changed = true;
          }
          break;
        }
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
        default: break;
      }

      // Handle dimension constraints (duck-typed)
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

    // Derived segment rules
    for (const seg of scene.segments) {
      const si = ss.get(seg);
      if (!si) continue;
      const s1 = ps.get(seg.p1), s2 = ps.get(seg.p2);
      if (!s1 || !s2) continue;
      if (si.dirKnown && si.lenKnown) {
        if (isFC(s1) && !isFC(s2) && markFC(s2)) changed = true;
        if (isFC(s2) && !isFC(s1) && markFC(s1)) changed = true;
      }
      if (si.lenKnown && !si.dirKnown) {
        if (isFC(s1) && !s2.radials.has(seg.p1)) { s2.radials.add(seg.p1); changed = true; }
        if (isFC(s2) && !s1.radials.has(seg.p2)) { s1.radials.add(seg.p2); changed = true; }
      }
    }
  }

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
  if (scene.splines) {
    for (const spl of scene.splines) {
      if (spl.points.every(p => fcPoints.has(p))) fcEntities.add(spl);
    }
  }
  if (scene.beziers) {
    for (const bez of scene.beziers) {
      if (bez.points.every(p => fcPoints.has(p))) fcEntities.add(bez);
    }
  }

  return { points: fcPoints, entities: fcEntities };
}

// ---------------------------------------------------------------------------
// Closed-loop detection for segment/arc fill (ported from legacy renderer.js)
// Builds a point-adjacency graph and returns simple loops for subtle fills.
// ---------------------------------------------------------------------------

function _findClosedLoops(scene) {
  const TOL = 1e-4;
  const adj = new Map();
  const ensure = (pt) => { if (!adj.has(pt)) adj.set(pt, []); };
  const selfClosedLoops = []; // Loops formed by a single self-closing curve (p1 === p2)

  for (const seg of scene.segments) {
    if (!seg.visible || seg.construction) continue;
    ensure(seg.p1);
    ensure(seg.p2);
    adj.get(seg.p1).push({ edge: seg, other: seg.p2 });
    adj.get(seg.p2).push({ edge: seg, other: seg.p1 });
  }

  for (const arc of scene.arcs) {
    if (!arc.visible || arc.construction) continue;
    const sp = arc.startPt, ep = arc.endPt;
    let pStart = null, pEnd = null;
    for (const pt of scene.points) {
      if (!pStart && Math.hypot(pt.x - sp.x, pt.y - sp.y) < TOL) pStart = pt;
      if (!pEnd && Math.hypot(pt.x - ep.x, pt.y - ep.y) < TOL) pEnd = pt;
    }
    if (pStart && pEnd && pStart !== pEnd) {
      ensure(pStart);
      ensure(pEnd);
      adj.get(pStart).push({ edge: arc, other: pEnd });
      adj.get(pEnd).push({ edge: arc, other: pStart });
    }
  }

  // Include splines in the adjacency graph (endpoints participate in loops)
  if (scene.splines) {
    for (const spl of scene.splines) {
      if (!spl.visible || spl.construction) continue;
      const p1 = spl.p1, p2 = spl.p2;
      if (p1 && p2 && p1 === p2) {
        // Self-closing spline — forms its own loop
        // Tessellate the curve to get the polygon points for the loop
        const pts = spl.tessellate2D(32);
        if (pts.length >= 3) {
          selfClosedLoops.push({ points: pts.map(p => ({ x: p.x, y: p.y })), edges: [spl] });
        }
      } else if (p1 && p2) {
        ensure(p1);
        ensure(p2);
        adj.get(p1).push({ edge: spl, other: p2 });
        adj.get(p2).push({ edge: spl, other: p1 });
      }
    }
  }

  // Include beziers in the adjacency graph (endpoints participate in loops)
  if (scene.beziers) {
    for (const bez of scene.beziers) {
      if (!bez.visible || bez.construction) continue;
      const p1 = bez.p1, p2 = bez.p2;
      if (p1 && p2 && p1 === p2) {
        // Self-closing bezier — forms its own loop
        const pts = bez.tessellate2D(16);
        if (pts.length >= 3) {
          selfClosedLoops.push({ points: pts.map(p => ({ x: p.x, y: p.y })), edges: [bez] });
        }
      } else if (p1 && p2) {
        ensure(p1);
        ensure(p2);
        adj.get(p1).push({ edge: bez, other: p2 });
        adj.get(p2).push({ edge: bez, other: p1 });
      }
    }
  }

  const visited = new Set();
  const loops = [];

  for (const [pt] of adj) {
    if (visited.has(pt)) continue;
    const component = [];
    const queue = [pt];
    const seen = new Set();
    while (queue.length > 0) {
      const cur = queue.shift();
      if (seen.has(cur)) continue;
      seen.add(cur);
      component.push(cur);
      for (const { other } of adj.get(cur)) {
        if (!seen.has(other)) queue.push(other);
      }
    }
    for (const p of component) visited.add(p);
    if (component.length < 3) continue;
    if (component.some(p => (adj.get(p) || []).length !== 2)) continue;

    const orderedPts = [];
    const orderedEdges = [];
    let current = component[0];
    let prevEdge = null;
    for (let i = 0; i < component.length; i++) {
      orderedPts.push(current);
      const neighbors = adj.get(current);
      const next = prevEdge
        ? neighbors.find(n => n.edge !== prevEdge)
        : neighbors[0];
      orderedEdges.push(next.edge);
      prevEdge = next.edge;
      current = next.other;
    }
    loops.push({ points: orderedPts, edges: orderedEdges });
  }

  // Add self-closing loops (single curves with p1 === p2)
  for (const sl of selfClosedLoops) {
    loops.push(sl);
  }

  return loops;
}

export function extractRenderableSketchProfiles(sketch, isLayerVisible = null) {
  if (!sketch) return [];
  const source = typeof isLayerVisible === 'function'
    ? {
        ...sketch,
        segments: (sketch.segments || []).filter((entity) => entity?.layer == null || isLayerVisible(entity.layer)),
        circles: (sketch.circles || []).filter((entity) => entity?.layer == null || isLayerVisible(entity.layer)),
        arcs: (sketch.arcs || []).filter((entity) => entity?.layer == null || isLayerVisible(entity.layer)),
        splines: (sketch.splines || []).filter((entity) => entity?.layer == null || isLayerVisible(entity.layer)),
        beziers: (sketch.beziers || []).filter((entity) => entity?.layer == null || isLayerVisible(entity.layer)),
      }
    : sketch;
  const feature = Object.create(SketchFeature.prototype);
  feature.sketch = source;
  return feature.extractProfiles();
}

function _appendPolylineProfilePath(ctx, profile, projectPoint) {
  const points = Array.isArray(profile?.points) ? profile.points : [];
  if (points.length < 3) return;
  const first = projectPoint(points[0]);
  ctx.moveTo(first.x, first.y);
  for (let i = 1; i < points.length; i++) {
    const point = projectPoint(points[i]);
    ctx.lineTo(point.x, point.y);
  }
  ctx.closePath();
}

function _groupSketchProfiles(profiles) {
  const groups = [];
  for (let i = 0; i < profiles.length; i++) {
    const profile = profiles[i];
    if (profile?.isHole) continue;
    const holes = [];
    for (const holeIndex of profile?.holes || []) {
      const hole = profiles[holeIndex];
      if (hole) holes.push(hole);
    }
    groups.push({ outer: profile, holes });
  }
  return groups;
}

export function triangulateSketchProfileFill(profiles, options = {}) {
  const triangles = [];
  const triangulationOptions = options.recoverBoundaryVertices === true
    ? undefined
    : { recoverBoundaryVertices: false };
  for (const group of _groupSketchProfiles(profiles)) {
    const outer = _simplifyProfileFillRing(_normalizeProfileRing(group.outer.points, false), options);
    const holes = group.holes
      .map((hole) => _simplifyProfileFillRing(_normalizeProfileRing(hole.points, true), options))
      .filter((ring) => ring.length >= 3);
    if (outer.length < 3) continue;
    const triIndices = triangulationOptions
      ? constrainedTriangulate(outer, holes, [], triangulationOptions)
      : constrainedTriangulate(outer, holes);
    const triPoints = [
      ...outer,
      ...holes.flat(),
    ];
    for (const [ia, ib, ic] of triIndices) {
      const a = triPoints[ia];
      const b = triPoints[ib];
      const c = triPoints[ic];
      if (a && b && c) triangles.push([a, b, c]);
    }
  }
  return triangles;
}

function _simplifyProfileFillRing(points, options = {}) {
  if (!Array.isArray(points) || points.length < 96 || options.simplify === false) return points;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const diag = Math.hypot(maxX - minX, maxY - minY);
  const tolerance = Number.isFinite(options.simplifyTolerance)
    ? Math.max(0, options.simplifyTolerance)
    : Math.max(diag * 0.00025, 1e-5);
  if (tolerance <= 0) return points;
  const simplified = _simplifyClosedRing(points, tolerance);
  return simplified.length >= 3 ? simplified : points;
}

function _simplifyClosedRing(points, tolerance) {
  let anchor = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i].x < points[anchor].x || (points[i].x === points[anchor].x && points[i].y < points[anchor].y)) {
      anchor = i;
    }
  }
  const rotated = [...points.slice(anchor), ...points.slice(0, anchor), points[anchor]];
  const simplified = _simplifyOpenPolyline(rotated, tolerance);
  if (simplified.length > 1) simplified.pop();
  return simplified;
}

function _simplifyOpenPolyline(points, tolerance) {
  if (points.length <= 2) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [start, end] = stack.pop();
    let maxDistance = -1;
    let split = -1;
    for (let i = start + 1; i < end; i++) {
      const distance = _pointLineDistance2D(points[i], points[start], points[end]);
      if (distance > maxDistance) {
        maxDistance = distance;
        split = i;
      }
    }
    if (maxDistance > tolerance && split > start) {
      keep[split] = 1;
      stack.push([start, split], [split, end]);
    }
  }
  const result = [];
  for (let i = 0; i < points.length; i++) {
    if (keep[i]) result.push(points[i]);
  }
  return result;
}

function _pointLineDistance2D(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len <= 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / len;
}

function _normalizeProfileRing(points, clockwise) {
  const ring = Array.isArray(points)
    ? points.map((point) => ({ x: point.x, y: point.y }))
    : [];
  if (ring.length < 3) return [];
  if (_signedArea2D(ring) === 0) return [];
  const isClockwise = _signedArea2D(ring) < 0;
  if (isClockwise !== clockwise) ring.reverse();
  return ring;
}

function _signedArea2D(points) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area * 0.5;
}

/**
 * Simple ear-clipping triangulation for a 2D polygon.
 * @param {Array<{x:number,y:number}>} polygon - Array of 2D points (CCW or CW winding)
 * @returns {Array<[{x:number,y:number},{x:number,y:number},{x:number,y:number}]>} triangles
 */
function _earClipTriangulate(polygon) {
  if (polygon.length < 3) return [];
  if (polygon.length === 3) return [[polygon[0], polygon[1], polygon[2]]];

  const tris = [];
  const pts = polygon.map(p => ({ x: p.x, y: p.y }));

  // Determine winding direction (signed area)
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    area += (pts[j].x - pts[i].x) * (pts[j].y + pts[i].y);
  }
  const ccw = area < 0; // in screen coords, negative area = CCW

  const isConvex = (a, b, c) => {
    const cross = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    return ccw ? cross > 0 : cross < 0;
  };

  const pointInTriangle = (p, a, b, c) => {
    const d1 = (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
    const d2 = (p.x - c.x) * (b.y - c.y) - (b.x - c.x) * (p.y - c.y);
    const d3 = (p.x - a.x) * (c.y - a.y) - (c.x - a.x) * (p.y - a.y);
    const hasNeg = (d1 < 0) || (d2 < 0) || (d3 < 0);
    const hasPos = (d1 > 0) || (d2 > 0) || (d3 > 0);
    return !(hasNeg && hasPos);
  };

  const indices = [];
  for (let i = 0; i < pts.length; i++) indices.push(i);

  let safe = indices.length * 2;
  while (indices.length > 2 && safe-- > 0) {
    let earFound = false;
    for (let i = 0; i < indices.length; i++) {
      const prev = indices[(i + indices.length - 1) % indices.length];
      const cur = indices[i];
      const next = indices[(i + 1) % indices.length];
      const a = pts[prev], b = pts[cur], c = pts[next];
      if (!isConvex(a, b, c)) continue;
      let hasInside = false;
      for (let j = 0; j < indices.length; j++) {
        const idx = indices[j];
        if (idx === prev || idx === cur || idx === next) continue;
        if (pointInTriangle(pts[idx], a, b, c)) { hasInside = true; break; }
      }
      if (hasInside) continue;
      tris.push([a, b, c]);
      indices.splice(i, 1);
      earFound = true;
      break;
    }
    if (!earFound) break;
  }
  return tris;
}

// ---------------------------------------------------------------------------
// Draw snap indicator shape on overlay canvas (legacy style)
// Different shapes for each snap type.
// ---------------------------------------------------------------------------

function _drawSnapIndicator(ctx, screenPt, snapType) {
  const sz = 6;
  const sx = screenPt.x;
  const sy = screenPt.y;

  ctx.save();
  ctx.strokeStyle = '#ffff00';
  ctx.lineWidth = 1.5;

  switch (snapType) {
    case 'endpoint':
      ctx.strokeRect(sx - sz, sy - sz, sz * 2, sz * 2);
      break;
    case 'midpoint':
      ctx.beginPath();
      ctx.moveTo(sx, sy - sz);
      ctx.lineTo(sx + sz, sy + sz);
      ctx.lineTo(sx - sz, sy + sz);
      ctx.closePath();
      ctx.stroke();
      break;
    case 'center':
      ctx.beginPath();
      ctx.arc(sx, sy, sz, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx - sz, sy); ctx.lineTo(sx + sz, sy);
      ctx.moveTo(sx, sy - sz); ctx.lineTo(sx, sy + sz);
      ctx.stroke();
      break;
    case 'quadrant':
      ctx.beginPath();
      ctx.moveTo(sx, sy - sz);
      ctx.lineTo(sx + sz, sy);
      ctx.lineTo(sx, sy + sz);
      ctx.lineTo(sx - sz, sy);
      ctx.closePath();
      ctx.stroke();
      break;
    case 'origin':
      ctx.beginPath();
      ctx.arc(sx, sy, sz + 1, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(sx - sz - 1, sy); ctx.lineTo(sx + sz + 1, sy);
      ctx.moveTo(sx, sy - sz - 1); ctx.lineTo(sx, sy + sz + 1);
      ctx.stroke();
      break;
    case 'grid':
      ctx.beginPath();
      ctx.moveTo(sx - sz, sy); ctx.lineTo(sx + sz, sy);
      ctx.moveTo(sx, sy - sz); ctx.lineTo(sx, sy + sz);
      ctx.stroke();
      break;
    default:
      // Fallback: small filled circle
      ctx.fillStyle = '#ffff00';
      ctx.beginPath();
      ctx.arc(sx, sy, 3, 0, Math.PI * 2);
      ctx.fill();
      break;
  }
  ctx.restore();
}

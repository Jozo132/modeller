import { renderBaseMeshOverlay } from './mesh-overlay-renderer.js';
import {
  buildMeshRenderData,
  computeFitViewState,
  computeOrbitCameraPosition,
  computeOrbitMvp,
} from './part-render-core.js';
import { LodManager } from './lod-manager.js';
import { GpuTessPipeline } from './gpu-tess-pipeline.js';
import { loadReleaseWasmModule } from '../load-release-wasm.js';

export class SceneRenderer {
  constructor(options) {
    this.canvas = options.canvas;
    this.executor = options.executor;
    this.wasm = options.wasmModule || null;
    this.mode = '3d';
    this._ready = false;
    this._initPromise = null;
    this._fov = Math.PI / 4;
    this._fovDegrees = 45;
    this._orbitTheta = Math.PI / 4;
    this._orbitPhi = Math.PI / 3;
    this._orbitRadius = 25;
    this._orbitTarget = { x: 0, y: 0, z: 0 };
    this._orbitDirty = true;
    this._partBounds = null;
    this._meshTriangles = null;
    this._meshTriangleCount = 0;
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
    this._invisibleEdgesVisible = false;
    this._meshTriangleOverlayMode = 'off';

    // Static tessellation density. Keep the manager for compatibility, but
    // do not update it from camera movement or retessellate automatically.
    this._lodManager = new LodManager();
    this._currentPart = null;

    // WebGPU NURBS tessellation pipeline (optional, null if unavailable)
    this._gpuTessPipeline = null;
    this._gpuTessReady = false;
  }

  async init() {
    if (this._ready) return;
    if (!this._initPromise) {
      this._initPromise = (async () => {
        const wasm = this.wasm || await loadReleaseWasmModule();
        this.wasm = wasm;
        this.wasm.init(this.canvas.width, this.canvas.height);
        this._ready = true;
        this.setMode('3d');

        // Attempt WebGPU tessellation pipeline (non-blocking, fallback-safe).
        // The pipeline requires a WasmBrepHandleRegistry to upload data.
        // We create the pipeline here for capability detection; the registry
        // is attached later via initGpuTessPipeline(registry) when available.
        if (GpuTessPipeline.isAvailable()) {
          try {
            this._gpuTessPipeline = new GpuTessPipeline();
            // Don't init yet — needs registry. Just mark as detected.
            this._gpuTessReady = false;
          } catch {
            this._gpuTessPipeline = null;
            this._gpuTessReady = false;
          }
        }
      })().catch((error) => {
        this._initPromise = null;
        throw error;
      });
    }
    await this._initPromise;
  }

  /**
   * Initialize the GPU tessellation pipeline with a handle registry.
   * Call after both init() and the registry are available.
   * @param {import('../cad/WasmBrepHandleRegistry.js').WasmBrepHandleRegistry} registry
   * @returns {Promise<boolean>}
   */
  async initGpuTessPipeline(registry) {
    if (!this._gpuTessPipeline || !registry) return false;
    try {
      this._gpuTessReady = await this._gpuTessPipeline.init(registry);
      return this._gpuTessReady;
    } catch {
      this._gpuTessReady = false;
      return false;
    }
  }

  setSize(width, height) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.executor.resize(width, height);
    if (this._ready) this.wasm.resize(width, height);
  }

  setMode(mode) {
    this.mode = mode;
    if (!this._ready) return;
    if (mode === '2d') {
      const aspect = this.canvas.width / this.canvas.height;
      const viewSize = 500;
      this.wasm.setCameraMode(0);
      this.wasm.setOrthoBounds(-viewSize * aspect, viewSize * aspect, -viewSize, viewSize);
      this.wasm.setCameraPosition(0, 0, 500);
      this.wasm.setCameraTarget(0, 0, 0);
      this.wasm.setCameraUp(0, 1, 0);
      return;
    }
    this.wasm.setCameraMode(1);
    this.wasm.setCameraUp(0, 0, 1);
    this.wasm.setGridVisible(1);
    this.wasm.setAxesVisible(1);
    this.wasm.setGridSize(200, 20);
    this.wasm.setAxesSize(50);
    this.wasm.clearEntities();
    this.wasm.resetEntityModelMatrix();
    this._orbitDirty = true;
    this._applyOrbitCamera();
  }

  getOrbitState() {
    return {
      theta: this._orbitTheta,
      phi: this._orbitPhi,
      radius: this._orbitRadius,
      target: { ...this._orbitTarget },
    };
  }

  setInvisibleEdgesVisible(enabled) {
    this._invisibleEdgesVisible = !!enabled;
  }

  setMeshTriangleOverlayMode(mode) {
    this._meshTriangleOverlayMode = mode === 'outline' ? 'outline' : 'off';
  }

  setOrbitState(state) {
    if (!state) return;
    if (state.theta != null) this._orbitTheta = state.theta;
    if (state.phi != null) this._orbitPhi = state.phi;
    if (state.radius != null) this._orbitRadius = state.radius;
    if (state.target) this._orbitTarget = { x: state.target.x || 0, y: state.target.y || 0, z: state.target.z || 0 };
    this._orbitDirty = true;
  }

  fitToView() {
    const fit = computeFitViewState(this._partBounds, 25);
    this._orbitTarget = fit.target;
    this._orbitRadius = fit.radius;
    this.wasm.setGridSize(fit.gridSize, 20);
    this.wasm.setAxesSize(fit.axesSize);
    this._orbitTheta = Math.PI / 4;
    this._orbitPhi = Math.PI / 3;
    this._orbitDirty = true;
    this._applyOrbitCamera();
  }

  renderPart(part) {
    this.clearPartGeometry();
    this._currentPart = part;
    if (!part || !this._ready) return;

    if (this.wasm.setOriginPlanesVisible) {
      const planes = part.getOriginPlanes ? part.getOriginPlanes() : {};
      let mask = 0;
      if (!planes.XY || planes.XY.visible) mask |= 1;
      if (!planes.XZ || planes.XZ.visible) mask |= 2;
      if (!planes.YZ || planes.YZ.visible) mask |= 4;
      this.wasm.setOriginPlanesVisible(mask);
    }

    const geo = part.getFinalGeometry();
    if (geo?.type === 'solid' && geo.geometry) {
      this._partBounds = geo.boundingBox || null;
      this._buildMeshFromGeometry(geo.geometry);
    }
  }

  renderFrame() {
    if (!this._ready) return;
    if (this.mode === '3d' && this._orbitDirty) {
      this._applyOrbitCamera();
      this._orbitDirty = false;
    }
    this.wasm.render();
    const ptr = this.wasm.getCommandBufferPtr();
    const len = this.wasm.getCommandBufferLen();
    if (len > 0) {
      const memory = this.wasm.memory || (this.wasm.__getMemory && this.wasm.__getMemory());
      if (memory) {
        const commandBuffer = new Float32Array(memory.buffer, ptr, len);
        this.executor.execute(commandBuffer, len);
      }
    }
    this._renderMeshOverlay();
  }

  hasGeometry() {
    return !!(this._meshTriangles && this._meshTriangleCount > 0);
  }

  clearPartGeometry() {
    this._partBounds = null;
    this._meshTriangles = null;
    this._meshTriangleCount = 0;
    this._meshEdges = null;
    this._meshEdgeVertexCount = 0;
    this._meshVisualEdges = null;
    this._meshVisualEdgeVertexCount = 0;
    this._meshSilhouetteCandidates = null;
    this._meshBoundaryEdges = null;
    this._meshBoundaryEdgeVertexCount = 0;
    this._problemTriangles = null;
    this._problemTriangleCount = 0;
  }

  _applyOrbitCamera() {
    if (!this._ready) return;
    const t = this._orbitTarget;
    const camera = computeOrbitCameraPosition(this._orbitTheta, this._orbitPhi, this._orbitRadius, t);
    this.wasm.setCameraPosition(camera.x, camera.y, camera.z);
    this.wasm.setCameraTarget(t.x, t.y, t.z);
    const dx = t.x - camera.x;
    const dy = t.y - camera.y;
    const dz = t.z - camera.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len > 1e-8) {
      this.executor.setViewDir(dx / len, dy / len, dz / len);
    }
    // Scale origin planes and axes with the orbit radius
    if (this.wasm.setOriginPlaneScale) {
      this.wasm.setOriginPlaneScale(this._orbitRadius * 0.2);
    }
  }

  _buildMeshFromGeometry(geometry) {
    Object.assign(this, buildMeshRenderData(geometry));
  }

  _renderMeshOverlay() {
    if (!this._meshTriangles || this._meshTriangleCount === 0) return;
    const mvp = this._computeMvp();
    if (!mvp) return;

    // Re-enable depth testing if the executor supports it (mirrors WasmRenderer setup).
    if (this.executor.setDepthTest) {
      this.executor.setDepthTest(true);
    }

    renderBaseMeshOverlay(this.executor, {
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
      meshEdgeSegments: this._meshEdgeSegments,
      meshSilhouetteCandidates: this._meshSilhouetteCandidates,
      meshBoundaryEdges: this._meshBoundaryEdges,
      meshBoundaryEdgeVertexCount: this._meshBoundaryEdgeVertexCount,
      orbitState: this.getOrbitState(),
      mvp,
      diagnosticHatch: this.diagnosticHatch,
      showInvisibleEdges: this._invisibleEdgesVisible,
      meshTriangleOverlayMode: this._meshTriangleOverlayMode,
      problemTriangles: this._problemTriangles,
      problemTriangleCount: this._problemTriangleCount,
    });
  }

  _computeMvp() {
    return computeOrbitMvp({
      width: this.canvas.width,
      height: this.canvas.height,
      target: this._orbitTarget,
      theta: this._orbitTheta,
      phi: this._orbitPhi,
      radius: this._orbitRadius,
      fov: this._fov,
      fovDegrees: this._fovDegrees,
      ortho3D: false,
      orthoBounds: null,
    });
  }

  /** @returns {LodManager} */
  get lodManager() { return this._lodManager; }

  /** @returns {GpuTessPipeline|null} */
  get gpuTessPipeline() { return this._gpuTessPipeline; }

  /** @returns {boolean} */
  get gpuTessReady() { return this._gpuTessReady; }
}

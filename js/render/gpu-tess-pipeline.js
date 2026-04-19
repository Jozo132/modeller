// @ts-nocheck
/**
 * WebGPU NURBS tessellation pipeline.
 *
 * Connects the WASM kernel/gpu.ts batch buffers to a WebGPU compute pipeline
 * that evaluates NURBS surface points + normals on the GPU. The output stays
 * in VRAM as a vertex buffer, ready for direct rendering.
 *
 * Usage:
 *   const pipe = new GpuTessPipeline();
 *   await pipe.init(registry);
 *   pipe.uploadBatch();        // zero-copy from WASM → GPU
 *   await pipe.dispatch();     // compute shader runs
 *   const vb = pipe.getOutputBuffer();  // GPU vertex buffer
 *
 * Falls back to null if WebGPU is not available.
 */

import { NURBS_TESS_WGSL } from './nurbs-tess.wgsl.js';

export class GpuTessPipeline {
    /** @type {GPUDevice|null} */
    #device = null;
    /** @type {GPUComputePipeline|null} */
    #pipeline = null;
    /** @type {GPUBuffer|null} */
    #headerBuf = null;
    /** @type {GPUBuffer|null} */
    #ctrlBuf = null;
    /** @type {GPUBuffer|null} */
    #knotBuf = null;
    /** @type {GPUBuffer|null} */
    #outputBuf = null;
    /** @type {GPUBuffer|null} */
    #paramsBuf = null;
    /** @type {GPUBindGroupLayout|null} */
    #bindGroupLayout = null;

    /** @type {import('./WasmBrepHandleRegistry').WasmBrepHandleRegistry|null} */
    #registry = null;

    #maxOutputVerts = 0;
    #ready = false;

    /**
     * Initialize the WebGPU pipeline.
     * @param {import('../cad/WasmBrepHandleRegistry').WasmBrepHandleRegistry} registry
     * @param {object} [opts]
     * @param {number} [opts.maxOutputVerts=262144] — max tessellation vertices
     * @returns {Promise<boolean>} — true if GPU is available and initialized
     */
    async init(registry, opts = {}) {
        this.#registry = registry;
        this.#maxOutputVerts = opts.maxOutputVerts || 262144;

        if (typeof navigator === 'undefined' || !navigator.gpu) {
            return false;
        }

        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) return false;

            this.#device = await adapter.requestDevice();
            if (!this.#device) return false;
        } catch {
            return false;
        }

        const device = this.#device;

        // Create shader module
        const shaderModule = device.createShaderModule({
            label: 'nurbs-tess-compute',
            code: NURBS_TESS_WGSL,
        });

        // Bind group layout
        this.#bindGroupLayout = device.createBindGroupLayout({
            label: 'nurbs-tess-bgl',
            entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
                { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
                { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
            ],
        });

        // Pipeline
        this.#pipeline = device.createComputePipeline({
            label: 'nurbs-tess-pipeline',
            layout: device.createPipelineLayout({
                bindGroupLayouts: [this.#bindGroupLayout],
            }),
            compute: {
                module: shaderModule,
                entryPoint: 'main',
            },
        });

        // Allocate GPU buffers (sized for max batch)
        // Headers: 256 surfaces × 48 bytes = 12KB
        this.#headerBuf = device.createBuffer({
            label: 'nurbs-headers',
            size: 256 * 48,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Control points: 65536 × 16 bytes = 1MB
        this.#ctrlBuf = device.createBuffer({
            label: 'nurbs-ctrl-pts',
            size: 65536 * 16,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Knots: 65536 × 4 bytes = 256KB
        this.#knotBuf = device.createBuffer({
            label: 'nurbs-knots',
            size: 65536 * 4,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });

        // Output: maxVerts × 32 bytes (pos vec4 + normal vec4)
        this.#outputBuf = device.createBuffer({
            label: 'nurbs-tess-output',
            size: this.#maxOutputVerts * 32,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC,
        });

        // Params uniform: 16 bytes (surfaceIndex, vertexOffset, pad, pad)
        this.#paramsBuf = device.createBuffer({
            label: 'nurbs-tess-params',
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        this.#ready = true;
        return true;
    }

    /** @returns {boolean} */
    get ready() { return this.#ready; }

    /**
     * Upload the WASM batch buffers to the GPU.
     * Zero-copy: reads directly from WASM linear memory via typed array views.
     */
    uploadBatch() {
        if (!this.#ready || !this.#registry) return;

        const device = this.#device;
        const reg = this.#registry;

        // Headers
        const headerView = reg.getGpuHeaderBuffer();
        if (headerView && headerView.byteLength > 0) {
            device.queue.writeBuffer(this.#headerBuf, 0, headerView);
        }

        // Control points
        const ctrlView = reg.getGpuCtrlPointBuffer();
        if (ctrlView && ctrlView.byteLength > 0) {
            device.queue.writeBuffer(this.#ctrlBuf, 0, ctrlView);
        }

        // Knots
        const knotView = reg.getGpuKnotBuffer();
        if (knotView && knotView.byteLength > 0) {
            device.queue.writeBuffer(this.#knotBuf, 0, knotView);
        }
    }

    /**
     * Dispatch the compute shader for all surfaces in the current batch.
     * Each surface is dispatched separately with its own params uniform
     * to allow per-surface vertex offset tracking.
     *
     * @returns {Promise<void>}
     */
    async dispatch() {
        if (!this.#ready || !this.#registry) return;

        const device = this.#device;
        const surfaceCount = this.#registry.getGpuSurfaceCount();
        if (surfaceCount === 0) return;

        let vertexOffset = 0;
        const encoder = device.createCommandEncoder({ label: 'nurbs-tess-dispatch' });
        const pass = encoder.beginComputePass({ label: 'nurbs-tess-pass' });
        pass.setPipeline(this.#pipeline);

        const paramsData = new Uint32Array(4);

        for (let s = 0; s < surfaceCount; s++) {
            // Read the header to get tessSegsU/V for workgroup count
            const headerView = this.#registry.getGpuHeaderBuffer();
            const segsU = headerView[s * 12 + 7]; // tessSegsU
            const segsV = headerView[s * 12 + 8]; // tessSegsV
            const totalVerts = (segsU + 1) * (segsV + 1);

            // Update params
            paramsData[0] = s;              // surfaceIndex
            paramsData[1] = vertexOffset;   // vertexOffset
            paramsData[2] = 0;
            paramsData[3] = 0;
            device.queue.writeBuffer(this.#paramsBuf, 0, paramsData);

            // Create bind group
            const bindGroup = device.createBindGroup({
                layout: this.#bindGroupLayout,
                entries: [
                    { binding: 0, resource: { buffer: this.#headerBuf } },
                    { binding: 1, resource: { buffer: this.#ctrlBuf } },
                    { binding: 2, resource: { buffer: this.#knotBuf } },
                    { binding: 3, resource: { buffer: this.#outputBuf } },
                    { binding: 4, resource: { buffer: this.#paramsBuf } },
                ],
            });

            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(Math.ceil(totalVerts / 64));

            vertexOffset += totalVerts;
        }

        pass.end();
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
    }

    /**
     * Get the GPU output buffer for use as a vertex buffer in a render pass.
     * @returns {GPUBuffer|null}
     */
    getOutputBuffer() {
        return this.#outputBuf;
    }

    /**
     * Read tessellation output back to CPU (for debugging/fallback).
     * @param {number} vertexCount
     * @returns {Promise<Float32Array>}
     */
    async readback(vertexCount) {
        if (!this.#ready) return new Float32Array(0);

        const device = this.#device;
        const byteSize = vertexCount * 32; // 8 floats × 4 bytes
        const readBuf = device.createBuffer({
            size: byteSize,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        const encoder = device.createCommandEncoder();
        encoder.copyBufferToBuffer(this.#outputBuf, 0, readBuf, 0, byteSize);
        device.queue.submit([encoder.finish()]);

        await readBuf.mapAsync(GPUMapMode.READ);
        const result = new Float32Array(readBuf.getMappedRange().slice(0));
        readBuf.unmap();
        readBuf.destroy();

        return result;
    }

    /** Release GPU resources. */
    destroy() {
        if (this.#headerBuf) this.#headerBuf.destroy();
        if (this.#ctrlBuf) this.#ctrlBuf.destroy();
        if (this.#knotBuf) this.#knotBuf.destroy();
        if (this.#outputBuf) this.#outputBuf.destroy();
        if (this.#paramsBuf) this.#paramsBuf.destroy();
        if (this.#device) this.#device.destroy();
        this.#ready = false;
    }

    /**
     * Check if WebGPU is available in the current environment.
     * @returns {boolean}
     */
    static isAvailable() {
        return typeof navigator !== 'undefined' && !!navigator.gpu;
    }
}

export default GpuTessPipeline;

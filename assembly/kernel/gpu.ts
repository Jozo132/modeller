// kernel/gpu — @unmanaged std430-aligned types for WebGPU compute shader interop
//
// These structs are laid out to exactly match WGSL std430 storage buffer
// alignment. They use @unmanaged to prevent GC headers, ensuring contiguous
// byte-exact memory that JS can pass directly to device.queue.writeBuffer().

// ---------- std430-aligned types ----------

/**
 * NURBS control point: vec4<f32> (16 bytes).
 * w component serves as the rational weight for NURBS surfaces.
 */
@unmanaged
export class GpuControlPoint {
  x: f32;
  y: f32;
  z: f32;
  w: f32;
}

/**
 * Knot span descriptor for a parametric patch (16 bytes).
 */
@unmanaged
export class GpuKnotSpan {
  u0: f32;
  u1: f32;
  v0: f32;
  v1: f32;
}

/**
 * Per-surface header read by the compute shader (48 bytes = 3 × vec4).
 * Padding fields ensure 16-byte alignment of each group.
 */
@unmanaged
export class GpuSurfaceHeader {
  degreeU: u32;
  degreeV: u32;
  numCtrlU: u32;
  numCtrlV: u32;    // 16 bytes

  knotOffsetU: u32;
  knotOffsetV: u32;
  ctrlOffset: u32;
  tessSegsU: u32;   // 16 bytes

  tessSegsV: u32;
  _pad0: u32;
  _pad1: u32;
  _pad2: u32;       // 16 bytes = 48 total
}

// ---------- buffer management ----------

/** Max surfaces that can be batched in a single GPU dispatch. */
const MAX_GPU_SURFACES: u32 = 256;

/** Max total control points across all batched surfaces. */
const MAX_GPU_CTRL_POINTS: u32 = 65536;

/** Max total knots across all batched surfaces. */
const MAX_GPU_KNOTS: u32 = 65536;

// Pre-allocated contiguous buffers (these are the GPU upload source).
// Using heap_alloc for @unmanaged arrays would be ideal, but AS doesn't
// support @unmanaged arrays directly. Instead, use flat typed arrays
// that match the byte layout and export pointers.

/** Surface headers: 12 u32 per header (48 bytes). */
const headerBuf = new StaticArray<u32>(MAX_GPU_SURFACES * 12);
let headerCount: u32 = 0;

/** Control points: 4 f32 per point (16 bytes). */
const ctrlBuf = new StaticArray<f32>(MAX_GPU_CTRL_POINTS * 4);
let ctrlCount: u32 = 0;

/** Knot values: 1 f32 each. */
const knotBuf = new StaticArray<f32>(MAX_GPU_KNOTS);
let knotCount: u32 = 0;

// ---------- batch API ----------

/** Reset the GPU batch for a new frame. */
export function gpuBatchReset(): void {
  headerCount = 0;
  ctrlCount = 0;
  knotCount = 0;
}

/**
 * Add a surface to the GPU batch.
 * Copies the NURBS definition from the geometry pool into GPU-format buffers.
 * Returns the surface index in the batch (0-based) or 0xFFFFFFFF on overflow.
 */
export function gpuBatchAddSurface(
  degreeU: u32, degreeV: u32,
  numCtrlU: u32, numCtrlV: u32,
  knotsU: StaticArray<f32>,   // f32 for GPU precision
  knotsV: StaticArray<f32>,
  ctrlPts: StaticArray<f32>,  // x,y,z,w quads (already weighted)
  tessSegsU: u32, tessSegsV: u32
): u32 {
  if (headerCount >= MAX_GPU_SURFACES) return 0xFFFFFFFF;

  const nKnotsU: u32 = knotsU.length;
  const nKnotsV: u32 = knotsV.length;
  const nCtrl: u32 = numCtrlU * numCtrlV;

  if (knotCount + nKnotsU + nKnotsV > MAX_GPU_KNOTS) return 0xFFFFFFFF;
  if (ctrlCount + nCtrl > MAX_GPU_CTRL_POINTS) return 0xFFFFFFFF;

  // Write header
  const hOff = headerCount * 12;
  unchecked(headerBuf[hOff + 0] = degreeU);
  unchecked(headerBuf[hOff + 1] = degreeV);
  unchecked(headerBuf[hOff + 2] = numCtrlU);
  unchecked(headerBuf[hOff + 3] = numCtrlV);
  unchecked(headerBuf[hOff + 4] = knotCount);          // knotOffsetU
  unchecked(headerBuf[hOff + 5] = knotCount + nKnotsU); // knotOffsetV
  unchecked(headerBuf[hOff + 6] = ctrlCount);           // ctrlOffset
  unchecked(headerBuf[hOff + 7] = tessSegsU);
  unchecked(headerBuf[hOff + 8] = tessSegsV);
  unchecked(headerBuf[hOff + 9] = 0);   // _pad0
  unchecked(headerBuf[hOff + 10] = 0);  // _pad1
  unchecked(headerBuf[hOff + 11] = 0);  // _pad2

  // Copy knots
  for (let i: u32 = 0; i < nKnotsU; i++) {
    unchecked(knotBuf[knotCount + i] = unchecked(knotsU[i]));
  }
  knotCount += nKnotsU;
  for (let i: u32 = 0; i < nKnotsV; i++) {
    unchecked(knotBuf[knotCount + i] = unchecked(knotsV[i]));
  }
  knotCount += nKnotsV;

  // Copy control points (x,y,z,w per point)
  const nFloats = nCtrl * 4;
  for (let i: u32 = 0; i < nFloats; i++) {
    unchecked(ctrlBuf[ctrlCount * 4 + i] = unchecked(ctrlPts[i]));
  }
  ctrlCount += nCtrl;

  const surfIdx = headerCount;
  headerCount++;
  return surfIdx;
}

// ---------- buffer access for JS zero-copy bridge ----------

export function getGpuHeaderBufPtr(): usize { return changetype<usize>(headerBuf); }
export function getGpuHeaderBufLen(): u32 { return headerCount * 12; } // u32 count

export function getGpuCtrlBufPtr(): usize { return changetype<usize>(ctrlBuf); }
export function getGpuCtrlBufLen(): u32 { return ctrlCount * 4; } // f32 count

export function getGpuKnotBufPtr(): usize { return changetype<usize>(knotBuf); }
export function getGpuKnotBufLen(): u32 { return knotCount; } // f32 count

export function getGpuSurfaceCount(): u32 { return headerCount; }
